import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { resizePty, spawnSession, writePty } from "../../api/pty";
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

    // GPU-accelerated rendering. The default DOM renderer makes typing and
    // scrolling sluggish and chokes on claude's rapid full-screen TUI redraws;
    // WebGL offloads cell rendering to the GPU. If the GL context is lost (e.g.
    // tab backgrounded, driver hiccup) dispose the addon so xterm falls back to
    // the DOM renderer instead of freezing.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable — keep the DOM renderer */
    }

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

    // Clipboard: xterm doesn't copy/paste on its own. Wire Ctrl/Cmd+C (copy the
    // selection — falls through to ^C interrupt when nothing is selected) and
    // Ctrl/Cmd+V (paste via term.paste so claude's bracketed-paste mode is
    // respected). Shift variants (Ctrl+Shift+C/V) always copy/paste.
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
      if (key === "v") {
        navigator.clipboard
          ?.readText()
          .then((t) => t && term.paste(t))
          .catch(() => {});
        return false;
      }
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

    // IME (한글/CJK) input. There are two completely different webview behaviours
    // and we support both:
    //
    // 1) Chromium (Windows WebView2, Linux): fires real composition events. We
    //    swallow onData while composing and send the finished string on
    //    compositionend. The deferred flag-clear suppresses xterm's own trailing
    //    emit so it isn't duplicated.
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
    const unlistenOut = listen<PtyOutput>("pty-output", (e) => {
      if (e.payload.id !== id) return;
      term.write(e.payload.data, scheduleScan);
    });
    const unlistenExit = listen<string>("pty-exit", (e) => {
      if (e.payload !== id) return;
      term.writeln("\r\n[fleet] 세션 종료됨");
      onStatus?.(id, "stopped");
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        resizePty(id, term.cols, term.rows);
      } catch {
        /* hidden */
      }
    });
    ro.observe(hostRef.current!);

    return () => {
      if (scanTimer.current) window.clearTimeout(scanTimer.current);
      ta?.removeEventListener("compositionstart", onCompStart);
      ta?.removeEventListener("compositionend", onCompEnd);
      ta?.removeEventListener("keydown", onKeyDown);
      ta?.removeEventListener("input", onInput);
      ta?.removeEventListener("keyup", onKeyUp);
      dataSub.dispose();
      unlistenOut.then((f) => f());
      unlistenExit.then((f) => f());
      ro.disconnect();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Refit + focus when this tab becomes visible (xterm sized 0 while hidden).
  useEffect(() => {
    if (!visible) return;
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
