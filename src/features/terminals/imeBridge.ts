import { Terminal as XTerm } from "@xterm/xterm";
import { writePty } from "../../api/pty";

// Wire a terminal's keyboard input to the PTY.
//
// IME (한글/CJK) — why we do NOT let xterm handle composition:
//
// The two webviews behave completely differently, and xterm 6 gets Korean
// wrong on both:
//   • Tauri's macOS WKWebView fires NO composition events. xterm falls back to
//     `_handleAnyTextareaChanges()`, whose per-keydown diff is a string
//     `replace()` — Korean recomposition ("ㅌ" → "테") replaces the char
//     instead of appending, so the diff misfires and it sends BOTH the raw
//     jamo and the composed syllable (자음모음 분리/중복), or resends the whole
//     accumulated textarea.
//   • Chromium (Windows WebView2) fires real composition events, but xterm's
//     CompositionHelper only sends text on compositionend via deferred
//     setTimeout(0) reads of the textarea. Type fast and hit Enter and those
//     timers race the keydown — the last syllable is cut short or dropped.
//
// So this module owns IME entirely, the same way on every platform: while an
// "IME run" is active, the hidden textarea is the source of truth and we
// MIRROR it into the PTY in real time — erase the changed tail with DEL
// (\x7f), then type the new tail. Commit timing then doesn't matter at all:
// by the time Enter arrives, the line in claude already equals the textarea.
//
// To keep a SINGLE writer to the PTY (the historical bug here was two async
// writers racing), xterm must never process IME input. We intercept at
// `term.element` in the capture phase — that runs before xterm's own textarea
// listeners — and stopPropagation() for:
//   • keydown with keyCode 229 (every IME-processed keystroke on both
//     platforms) — starts/continues a run,
//   • composition{start,update,end} — always, so CompositionHelper stays
//     permanently dormant (it would otherwise re-send the syllable),
//   • input events during a run — the mirror consumes them instead of
//     xterm's `_inputEvent` (which would double-send commits that land after
//     keyup). Input events outside a run (dictation, emoji panel) still flow
//     to xterm untouched.
// Everything non-IME reaches xterm normally and arrives via `term.onData`,
// which we just forward.
//
// A run ends on any non-IME, non-modifier keydown (Enter, space, English,
// arrows, …): we reset state and clear the textarea so the next run diffs
// from a clean slate, then let xterm handle that key itself. Backspace while
// the run's textarea still has content is special: the browser/IME edits the
// textarea natively (shrinks marked text or deletes a committed char) and the
// resulting input event mirrors the erasure — letting xterm also send \x7f
// would double-delete.
//
// Returns a disposer that detaches every listener.

// Keys that never end an IME run: modifiers and IME mode keys.
// 16 Shift, 17 Ctrl, 18 Alt, 20 CapsLock (한/영 on remapped mac keyboards),
// 21 HangulMode(한/영), 25 Hanja(한자), 91/93 Meta, 229 IME-processed.
const RUN_NEUTRAL = new Set([16, 17, 18, 20, 21, 25, 91, 93, 229]);

export function attachInput(term: XTerm, id: string): () => void {
  const ta = term.textarea!;
  const root = term.element!;

  // TEMP IME diagnostic. Turn on in the devtools console with
  //   window.__imeDebug = true
  const dbg = (...a: unknown[]) => {
    if ((window as unknown as { __imeDebug?: boolean }).__imeDebug)
      console.log("[ime]", ...a);
  };

  let run = false; // inside an IME run: the textarea holds exactly what we've mirrored
  let sent = ""; // text already mirrored to the PTY during this run

  // Send the difference between the textarea and what the PTY already has:
  // DEL the changed tail, then type the new tail. Diff over code points (not
  // UTF-16 units) so astral chars don't over-erase.
  const mirror = () => {
    const next = ta.value;
    if (next === sent) return;
    const a = Array.from(sent);
    const b = Array.from(next);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    const out = "\x7f".repeat(a.length - common) + b.slice(common).join("");
    dbg("mirror", JSON.stringify(sent), "→", JSON.stringify(next), "out:", JSON.stringify(out));
    if (out) writePty(id, out);
    sent = next;
  };

  const startRun = () => {
    if (run) return;
    run = true;
    sent = "";
    // Drop stale residue (e.g. xterm's copy handler parks the selection text
    // in the textarea) so the first diff starts from a clean slate.
    ta.value = "";
    dbg("run start");
  };

  const endRun = () => {
    if (!run) return;
    run = false;
    sent = "";
    ta.value = "";
    dbg("run end");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    dbg("keydown", e.keyCode, e.key, "run:", run, "composing:", e.isComposing);
    if (e.keyCode === 229) {
      startRun();
      e.stopPropagation(); // xterm must never see IME keydowns (second writer)
      return;
    }
    if (!run) return;
    if (RUN_NEUTRAL.has(e.keyCode)) return;
    if (e.keyCode === 8 && ta.value.length > 0) {
      // Backspace inside a run: the textarea edit + input event handles it.
      e.stopPropagation();
      return;
    }
    // Any other key (Enter, space, English, arrows, Esc, …) ends the run and
    // is handled by xterm normally. The run's text is already fully mirrored,
    // so e.g. Enter submits the correct line.
    endRun();
  };

  const onInput = (e: Event) => {
    if (!run) return; // dictation / emoji panel etc. → xterm's own input path
    e.stopPropagation();
    mirror();
  };

  const onComposition = (e: CompositionEvent) => {
    dbg(e.type, JSON.stringify(e.data));
    // Composition can in theory start without a preceding 229 keydown.
    if (e.type === "compositionstart") startRun();
    e.stopPropagation(); // keep CompositionHelper dormant on Chromium
  };

  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("input", onInput, true);
  root.addEventListener("compositionstart", onComposition, true);
  root.addEventListener("compositionupdate", onComposition, true);
  root.addEventListener("compositionend", onComposition, true);

  const dataSub = term.onData((d) => {
    dbg("onData", JSON.stringify(d));
    writePty(id, d);
  });

  return () => {
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("input", onInput, true);
    root.removeEventListener("compositionstart", onComposition, true);
    root.removeEventListener("compositionupdate", onComposition, true);
    root.removeEventListener("compositionend", onComposition, true);
    dataSub.dispose();
  };
}
