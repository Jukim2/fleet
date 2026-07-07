import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { resizePty, spawnSession } from "../../api/pty";
import { attachInput } from "./imeBridge";
import { TermStatus } from "../../types";

type PtyOutput = { id: string; data: string };

// Claude Code shows this hint in its status line only while a turn is running.
const WORKING_RE = /esc to interrupt/i;

export default function Terminal({
  id,
  cwd,
  startup,
  visible,
  onStatus,
}: {
  id: string;
  cwd: string;
  startup: string;
  visible: boolean;
  onStatus?: (id: string, status: TermStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const imeRef = useRef<{ dispose: () => void; reset: () => void } | null>(null);
  const scanTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const term = new XTerm({
      fontSize: 13,
      // Cross-platform monospace. macOS fonts come first, then the Windows
      // ones (Cascadia ships with Windows Terminal; Consolas is always present)
      // so the box-drawing/braille glyphs in claude's TUI logo render in a true
      // monospace cell instead of falling back to Courier New (broken on Win).
      fontFamily:
        "Menlo, Monaco, 'SF Mono', 'Cascadia Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace",
      cursorBlink: true,
      theme: {
        background: "#101014",
        foreground: "#e4e4e7",
        cursor: "#a78bfa",
        selectionBackground: "#3b3b46",
      },
      scrollback: 8000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    fit.fit();

    // Renderer: xterm's default DOM renderer, deliberately NOT the WebGL addon.
    // WebGL is faster for claude's rapid full-screen redraws, but inside Tauri's
    // WKWebView its drawing buffer is not color-managed the way the rest of the
    // (React) UI is: on wide-gamut (P3) displays the compositor doesn't convert
    // the GL buffer's sRGB values to the display profile, so saturated colors
    // render with a shifted hue — claude's orange ✻ logo/emoji looked wrong
    // while identical colors elsewhere in the app looked right. The DOM renderer
    // draws each cell as ordinary color-managed HTML text, so its hues match the
    // rest of the UI exactly. The `@xterm/addon-canvas` renderer (also color-
    // managed) is deprecated and pinned to xterm 5, so it can't replace WebGL
    // here. Accept the small typing/scroll cost for correct color.

    // Claude's TUI enables mouse tracking, so by default xterm forwards wheel
    // events to the app instead of scrolling its own scrollback — the terminal
    // feels "stuck". When we're in the normal buffer (Claude doesn't use the
    // alternate screen), intercept the wheel and scroll xterm's history
    // ourselves; otherwise fall through to default handling.
    term.attachCustomWheelEventHandler((e) => {
      if (term.buffer.active.type === "normal" && term.modes.mouseTrackingMode !== "none") {
        term.scrollLines(Math.sign(e.deltaY) * 3);
        return false; // don't forward this wheel event to claude
      }
      return true;
    });

    // Clipboard: xterm doesn't copy on its own, so wire Ctrl/Cmd+C (copy the
    // selection — falls through to ^C interrupt when nothing is selected).
    //
    // Paste must ALWAYS arrive as the native `paste` event (imeBridge owns it:
    // text, clipboard images, copied files). On macOS Cmd+V isn't an xterm key
    // so the event fires naturally, but on Windows xterm maps Ctrl+V → \x16
    // and preventDefaults the keydown — the paste event never fires and images
    // can't attach. Return false for mod+V so xterm skips it and the browser's
    // genuine paste gesture goes through everywhere (also avoids macOS's
    // "붙여넣기 허용" prompt, which only programmatic clipboard reads trigger).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === "c" && (e.shiftKey || term.hasSelection())) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
        return false; // handled — don't also send ^C
      }
      if (key === "v") return false; // xterm hands-off → native paste event fires
      return true;
    });

    spawnSession(id, cwd, term.cols, term.rows, startup).catch((e) =>
      term.writeln(`\r\n[fleet] spawn error: ${e}`),
    );

    // Read the visible viewport and decide busy vs idle from what Claude's TUI
    // is actually showing: the "esc to interrupt" hint is present only while a
    // turn is running. This reflects the real screen, not output timing.
    const scan = () => {
      const buf = term.buffer.active;
      let text = "";
      for (let r = 0; r < term.rows; r++) {
        text += (buf.getLine(buf.baseY + r)?.translateToString(true) ?? "") + "\n";
      }
      onStatus?.(id, WORKING_RE.test(text) ? "busy" : "idle");
    };
    // Trailing throttle: at most one scan per 150ms, and one after the last frame.
    const scheduleScan = () => {
      if (scanTimer.current) return;
      scanTimer.current = window.setTimeout(() => {
        scanTimer.current = undefined;
        scan();
      }, 150);
    };

    // Keyboard input → PTY, including CJK/IME composition. See imeBridge.ts.
    const ime = attachInput(term, id);
    imeRef.current = ime;

    const unlistenOut = listen<PtyOutput>("pty-output", (e) => {
      if (e.payload.id !== id) return;
      term.write(e.payload.data, scheduleScan);
    });
    const unlistenExit = listen<string>("pty-exit", (e) => {
      if (e.payload !== id) return;
      term.writeln("\r\n[fleet] 세션 종료됨");
      onStatus?.(id, "stopped");
    });

    // Debounce refit/PTY-resize: while a side panel slides open the host resizes
    // every frame, and firing resizePty per frame makes Claude's TUI clear-and-
    // repaint each time (the flicker). Coalesce into one fit once resizing settles.
    // .term-float is overflow:hidden, so mid-animation the terminal just clips/
    // gaps against the matching dark bg instead of reflowing.
    let rzTimer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (rzTimer) window.clearTimeout(rzTimer);
      rzTimer = window.setTimeout(() => {
        rzTimer = undefined;
        try {
          fit.fit();
          resizePty(id, term.cols, term.rows);
        } catch {
          /* hidden */
        }
      }, 90);
    });
    ro.observe(hostRef.current!);

    return () => {
      if (scanTimer.current) window.clearTimeout(scanTimer.current);
      if (rzTimer) window.clearTimeout(rzTimer);
      imeRef.current = null;
      ime.dispose();
      unlistenOut.then((f) => f());
      unlistenExit.then((f) => f());
      ro.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Refit + focus when this tab becomes visible (xterm sized 0 while hidden).
  useEffect(() => {
    if (!visible) {
      // Hidden by a project/tab switch (display:none). WebView2 doesn't reliably
      // blur the textarea then, so clear any in-progress IME run explicitly —
      // otherwise a stale run on return double-writes the first Hangul syllable.
      imeRef.current?.reset();
      return;
    }
    const t = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        if (termRef.current) resizePty(id, termRef.current.cols, termRef.current.rows);
        termRef.current?.focus();
      } catch {
        /* */
      }
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible, id]);

  return <div className="term-host" ref={hostRef} />;
}
