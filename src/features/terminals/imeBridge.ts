import { Terminal as XTerm } from "@xterm/xterm";
import { writePty } from "../../api/pty";

// Wire a terminal's keyboard input to the PTY, including CJK/IME composition.
//
// IME (한글/CJK) input has two completely different webview behaviours and we
// support both:
//
// 1) Chromium (Windows WebView2, Linux): fires real composition events. We
//    swallow onData while composing and send the finished string on
//    compositionend. xterm's own CompositionHelper would ALSO emit the composed
//    text (via a deferred setTimeout that reads the textarea), so onCompEnd
//    blanks the textarea to suppress that duplicate — see the comment there.
//
// 2) Tauri's macOS WKWebView: does NOT fire composition events at all. Every
//    Korean keystroke is keyCode 229 and the syllable is delivered through
//    `input` events as inputType "insertReplacementText" — which xterm ignores
//    entirely. xterm forwards only the bare leading consonant (the lone
//    "insertText" jamo) to onData, so claude received "ㅇㄴㅎ…" instead of
//    "안녕하". The textarea value, however, always holds the correct composed
//    text. So for these keystrokes we ignore onData and instead mirror the
//    textarea into the PTY by diffing against what we've already sent: emit
//    backspaces (\x7f) to erase the part of the still-composing syllable that
//    changed, then the new tail. This keeps claude's input line exactly equal
//    to the textarea in real time, so Enter just submits the correct line.
//
// Returns a disposer that detaches every listener and the onData subscription.
export function attachInput(term: XTerm, id: string): () => void {
  let composing = false; // path 1: between compositionstart/end
  let compositionSeen = false; // has this webview ever fired compositionstart?
  let imeKey = false; // current keydown is IME-processed (keyCode 229)
  let imeSent = ""; // path 2: text already mirrored to the PTY this IME run
  const ta = term.textarea;

  const onCompStart = () => {
    composing = true;
    compositionSeen = true;
  };
  const onCompEnd = (e: CompositionEvent) => {
    if (e.data) writePty(id, e.data);
    // xterm's own CompositionHelper ALSO emits the composed text, via a
    // deferred setTimeout(0) that reads `textarea.value.substring(start)` and
    // fires onData. We've already sent e.data above, so that emit is a
    // duplicate. The `composing`-flag swallow below catches it only while the
    // flag is still set — but for the LAST syllable of a run (no following
    // compositionstart to keep the flag up) the deferred clear can win the
    // race and the emit leaks, duplicating the final syllable
    // ("테스트" → "테스트트"). Blank the textarea now — synchronously, before
    // xterm's timer fires — so its trailing emit reads "" and sends nothing.
    if (ta) ta.value = "";
    setTimeout(() => {
      composing = false;
    }, 0);
  };

  // Path 2 (WKWebView). Mirror the textarea value into the PTY by diffing.
  const mirrorTextarea = (next: string) => {
    let c = 0;
    const max = Math.min(imeSent.length, next.length);
    while (c < max && imeSent[c] === next[c]) c++;
    const back = imeSent.length - c; // chars to erase from the composing tail
    let out = back > 0 ? "\x7f".repeat(back) : "";
    out += next.slice(c);
    if (out) writePty(id, out);
    imeSent = next;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    imeKey = e.keyCode === 229;
    if (compositionSeen) return; // Chromium: composition events drive it
    if (imeKey) {
      // Start of a run: drop any stale residue so the first diff is clean.
      if (imeSent === "" && ta) ta.value = "";
    } else {
      // A non-IME key (space, Enter, English, arrows, …) ends the run. The
      // composed text is already mirrored into claude's line, so just reset and
      // let xterm handle this key normally via onData.
      imeSent = "";
      if (ta) ta.value = "";
    }
  };
  const onInput = () => {
    if (compositionSeen || composing) return; // Chromium handles it
    if (imeKey && ta) mirrorTextarea(ta.value);
  };
  // keyup fires after all of a keystroke's input events, so clearing here keeps
  // imeKey from sticking on between keystrokes (which would wrongly suppress a
  // later printable onData that arrives without its own keydown).
  const onKeyUp = () => {
    imeKey = false;
  };

  ta?.addEventListener("compositionstart", onCompStart);
  ta?.addEventListener("compositionend", onCompEnd);
  ta?.addEventListener("keydown", onKeyDown);
  ta?.addEventListener("input", onInput);
  ta?.addEventListener("keyup", onKeyUp);

  const dataSub = term.onData((d) => {
    if (composing) return; // path 1: swallow intermediate composition jamo
    // path 2: drop the bare leaked jamo (printable) while an IME key is active;
    // let control/escape sequences (mouse, focus, Ctrl-keys) through.
    if (imeKey && !compositionSeen && d.charCodeAt(0) !== 27) return;
    writePty(id, d);
  });

  return () => {
    ta?.removeEventListener("compositionstart", onCompStart);
    ta?.removeEventListener("compositionend", onCompEnd);
    ta?.removeEventListener("keydown", onKeyDown);
    ta?.removeEventListener("input", onInput);
    ta?.removeEventListener("keyup", onKeyUp);
    dataSub.dispose();
  };
}
