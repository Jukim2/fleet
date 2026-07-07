import { Terminal as XTerm } from "@xterm/xterm";
import { writePty } from "../../api/pty";
import { typeFilesAsPaths, typePaths } from "./attachFiles";
import { clipboardPaths } from "../../api/attach";

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
// Returns { dispose, reset }: `dispose` detaches every listener; `reset` clears
// any in-progress IME run (same as a blur) — the host calls it when the terminal
// is hidden, because a project switch hides the pane with `display:none` and
// WebView2 does NOT reliably fire the textarea `blur` in that case. Without it
// the run state survives the switch: on return the first Hangul keystroke sees a
// stale run, xterm's own composition path wakes up alongside our mirror, and the
// syllable is written twice (한 번 눌러도 여러 번 입력되는 버그).

// Keys that never end an IME run: modifiers and IME mode keys.
// 16 Shift, 17 Ctrl, 18 Alt, 20 CapsLock (한/영 on remapped mac keyboards),
// 21 HangulMode(한/영), 25 Hanja(한자), 91/93 Meta, 229 IME-processed.
const RUN_NEUTRAL = new Set([16, 17, 18, 20, 21, 25, 91, 93, 229]);

// Any Hangul: jamo (1100), compat jamo (3130), ext-A (A960), syllables + ext-B (AC00–D7FF).
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿]/;

export function attachInput(term: XTerm, id: string): { dispose: () => void; reset: () => void } {
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
  // Set when a printable key ends a run: xterm sends that key from its keydown
  // handler AND the browser leaks it into the (just-cleared) textarea, whose
  // input event would make xterm's own diff handler send it a SECOND time. We
  // swallow that one input event.
  let swallowNextInput = false;

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
    swallowNextInput = false; // a real IME keydown supersedes any pending swallow
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
    // macOS WKWebView quirk: the FIRST keystroke of a composition can arrive
    // as a plain keydown (real keyCode, `key` = the jamo) — 229 only starts on
    // the second key. Without this net xterm sends that raw jamo itself and
    // the first syllable of every run comes out 자음모음 분리.
    if (!run && !e.ctrlKey && !e.metaKey && !e.altKey && HANGUL.test(e.key)) {
      startRun();
      e.stopPropagation();
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
    // A printable ending key (space, letter, punctuation) is sent by xterm from
    // this keydown, but also leaks into the textarea endRun() just cleared —
    // xterm's own input listener would diff ""→" " and send it AGAIN (the Korean
    // "가  나" double-space; only after an IME run, since that's when we clear the
    // field). Swallow that leak's input event; the char is already on its way.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
      swallowNextInput = true;
  };

  const onInput = (e: Event) => {
    if (swallowNextInput) {
      // The run-ending printable key leaking into the textarea. xterm already
      // sent it via keydown; block its diff handler so it isn't doubled. Leave
      // the char in the textarea — the residue logic below subtracts it from the
      // next run's first mirror.
      swallowNextInput = false;
      e.stopPropagation();
      return;
    }
    if (!run) {
      // Same WKWebView first-keystroke quirk, second net: if the insertion is
      // composing or Hangul, claim the run here. The char is already in the
      // textarea, so start the run WITHOUT clearing it — with sent = "" the
      // next mirror() sends it. Paste and other non-IME input (dictation,
      // emoji panel) still flow to xterm's own input path.
      const ev = e as InputEvent;
      const ime =
        ev.inputType !== "insertFromPaste" &&
        (ev.isComposing || (typeof ev.data === "string" && HANGUL.test(ev.data)));
      if (!ime) return;
      run = true;
      // The textarea can still hold residue that xterm already emitted to the
      // PTY — e.g. the space that ended the PREVIOUS run: endRun() clears the
      // textarea, then xterm re-inserts the space and NEVER clears it (its
      // `_handleAnyTextareaChanges` only diffs, it doesn't reset the field).
      // Seeding sent="" would make mirror() re-send that leftover space along
      // with the new syllable → the space lands twice (가  나). Treat the part
      // before the just-inserted char as already-sent so only the new
      // insertion is mirrored.
      const data = typeof ev.data === "string" ? ev.data : "";
      sent = data && ta.value.endsWith(data)
        ? ta.value.slice(0, ta.value.length - data.length)
        : "";
      dbg("run start (input net)", ev.inputType, JSON.stringify(ev.data), "residue:", JSON.stringify(sent));
    }
    e.stopPropagation();
    mirror();
  };

  // xterm empties the hidden textarea on blur (`_handleTextAreaBlur`:
  // "Text can safely be removed on blur"), so a run must not survive one —
  // stale run/sent state after refocus is exactly both macOS Korean bugs:
  //   • first refocused keystroke arrives as 229 → startRun() no-ops (run
  //     already true) and the next mirror() diffs the now-empty textarea
  //     against the OLD run's `sent`, DEL-erasing everything back to the last
  //     space in claude's line;
  //   • it arrives as the plain-keydown jamo quirk instead → run is stale-true
  //     so the `!run` Hangul net is skipped, the keydown reads as run-ending,
  //     and xterm sends the raw jamo before the composition mirrors the
  //     composed syllable → 첫 글자 자음모음 분리.
  // The run's text is already fully mirrored to the PTY, so resetting state is
  // all that's needed.
  // Clear any in-progress run and pending swallow. Called on blur AND explicitly
  // by the host when the terminal is hidden (see the return-value doc above).
  const reset = () => {
    endRun();
    swallowNextInput = false;
  };

  const onBlur = () => {
    dbg("blur");
    reset();
  };

  const onComposition = (e: CompositionEvent) => {
    dbg(e.type, JSON.stringify(e.data));
    // Composition can in theory start without a preceding 229 keydown.
    if (e.type === "compositionstart") startRun();
    e.stopPropagation(); // keep CompositionHelper dormant on Chromium
  };

  // Paste: own it here too, for the same single-writer reason. Reading
  // clipboardData inside the genuine paste event is part of the user gesture,
  // so macOS shows no "붙여넣기 허용" prompt (unlike navigator.clipboard.readText).
  // We stopPropagation so xterm's own paste handler never runs — otherwise the
  // pasted text lands in the hidden textarea and the NEXT keystroke's diff
  // re-sends it (the "타이핑하면 또 붙여넣기" bug). term.paste() routes straight
  // through onData with claude's bracketed-paste wrapping, never touching the
  // textarea, so nothing lingers to be resent.
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    endRun(); // a paste ends any in-progress IME run and clears the textarea
    const files = Array.from(e.clipboardData?.files ?? []);
    const text = e.clipboardData?.getData("text") ?? "";
    dbg("paste", files.length, "files,", JSON.stringify(text.slice(0, 60)));
    void (async () => {
      // Files/folders copied in Explorer/Finder: the web event carries bytes at
      // best (a FOLDER carries nothing at all) — but the OS clipboard has the
      // REAL paths. Prefer those: no temp copy, and folders just work.
      if (files.length || !text) {
        const paths = await clipboardPaths().catch(() => [] as string[]);
        if (paths.length) {
          dbg("paste real paths", paths);
          typePaths(id, paths);
          return;
        }
      }
      // No OS path (e.g. a screenshot bitmap): save bytes to a temp file and
      // type that path — claude picks images up by path.
      if (files.length) {
        await typeFilesAsPaths(id, files);
        return;
      }
      if (text) term.paste(text);
    })();
  };

  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("input", onInput, true);
  root.addEventListener("compositionstart", onComposition, true);
  root.addEventListener("compositionupdate", onComposition, true);
  root.addEventListener("compositionend", onComposition, true);
  root.addEventListener("paste", onPaste, true);
  ta.addEventListener("blur", onBlur);

  const dataSub = term.onData((d) => {
    dbg("onData", JSON.stringify(d));
    writePty(id, d);
  });

  const dispose = () => {
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("input", onInput, true);
    root.removeEventListener("compositionstart", onComposition, true);
    root.removeEventListener("compositionupdate", onComposition, true);
    root.removeEventListener("compositionend", onComposition, true);
    root.removeEventListener("paste", onPaste, true);
    ta.removeEventListener("blur", onBlur);
    dataSub.dispose();
  };

  return { dispose, reset };
}
