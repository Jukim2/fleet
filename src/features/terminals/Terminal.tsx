import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

    const dataSub = term.onData((d) => writePty(id, d));
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
