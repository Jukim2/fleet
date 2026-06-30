import { Terminal as XTerm } from "@xterm/xterm";
import { writePty } from "../../api/pty";

// Wire a terminal's keyboard input to the PTY.
//
// IME (한글/CJK) handling lives entirely in xterm 6 now and we must NOT
// duplicate it. xterm 6 added two native IME paths:
//   • Chromium (Windows WebView2, Linux): real composition events, handled by
//     its CompositionHelper.
//   • Tauri's macOS WKWebView, which fires NO composition events: xterm's
//     `_handleAnyTextareaChanges()` snapshots the textarea on each keyCode-229
//     keydown and diffs it on a deferred timer, emitting the composed text via
//     onData.
// Both emit through `term.onData`, so all we do here is forward onData to the
// PTY. An earlier version of this file ran its OWN macOS textarea-diff mirror
// (a leftover from xterm 5). Against xterm 6 that meant two async writers racing
// to the same PTY, which corrupted Korean intermittently — "테" splitting into
// "ㅌㅔ", backspace desyncing, works-sometimes. Letting xterm own it fixes that.
//
// Returns a disposer that detaches the onData subscription.
export function attachInput(term: XTerm, id: string): () => void {
  // TEMP IME diagnostic. Turn on in the devtools console with
  //   window.__imeDebug = true
  const dbg = (...a: unknown[]) => {
    if ((window as unknown as { __imeDebug?: boolean }).__imeDebug)
      console.log("[ime]", ...a);
  };

  const dataSub = term.onData((d) => {
    dbg("onData d=", JSON.stringify(d));
    writePty(id, d);
  });

  return () => {
    dataSub.dispose();
  };
}
