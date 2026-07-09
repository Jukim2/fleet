import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { resizePty, spawnSession } from "../../api/pty";
import { watchAgentSession, unwatchAgentSession } from "../../api/agent";
import { attachInput } from "./imeBridge";
import { TermStatus } from "../../types";
import { agentOf } from "../../lib/agents";
import { readTermColors } from "../../lib/themes";

type PtyOutput = { id: string; data: string };

// Terminal font size is a single global preference (Ctrl +/-/0, Ctrl+wheel),
// persisted in localStorage and broadcast so every live terminal stays in sync.
const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 13;
const FONT_KEY = "fleet.termFontSize";
const FONT_EVENT = "fleet-term-fontsize";

function readFontSize(): number {
  const n = Number(localStorage.getItem(FONT_KEY));
  return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEFAULT;
}

function clampFont(n: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

// Rewrite an agent startup command to resume `sessionId`, preserving any flags.
// Non-agent startups (plain shell "") are returned unchanged (agentOf → claude,
// whose toResume no-ops when the command isn't `claude …`).
function resumeCommand(startup: string, sessionId: string): string {
  return agentOf(startup).toResume(startup, sessionId);
}

export default function Terminal({
  id,
  cwd,
  startup,
  resumeId,
  visible,
  onStatus,
}: {
  id: string;
  cwd: string;
  startup: string;
  resumeId?: string;
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
      fontSize: readFontSize(),
      // Cross-platform monospace. macOS fonts come first, then the Windows
      // ones (Cascadia ships with Windows Terminal; Consolas is always present)
      // so the box-drawing/braille glyphs in claude's TUI logo render in a true
      // monospace cell instead of falling back to Courier New (broken on Win).
      fontFamily:
        "Menlo, Monaco, 'SF Mono', 'Cascadia Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace",
      cursorBlink: true,
      // Terminal colors come from the active theme's CSS vars, read live so the
      // xterm palette matches the rest of the UI (and updates on theme switch).
      theme: readTermColors(),
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

    // Apply a font size to THIS terminal + refit; `broadcast` also persists it
    // and tells every other live terminal to match (single global preference).
    const applyFont = (size: number, broadcast: boolean) => {
      const next = clampFont(size);
      if (term.options.fontSize === next) return;
      term.options.fontSize = next;
      try {
        fit.fit();
        resizePty(id, term.cols, term.rows);
      } catch {
        /* hidden */
      }
      if (broadcast) {
        localStorage.setItem(FONT_KEY, String(next));
        window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: next }));
      }
    };
    // Sync when another terminal changes the size.
    const onFontEvent = (e: Event) => applyFont((e as CustomEvent<number>).detail, false);
    window.addEventListener(FONT_EVENT, onFontEvent);

    // Re-pull the terminal palette when the user switches theme (the CSS vars on
    // <html> have already changed by the time this fires).
    const onThemeEvent = () => {
      term.options.theme = readTermColors();
    };
    window.addEventListener("fleet-theme", onThemeEvent);

    // Ctrl/Cmd+wheel zooms the font. This must run BEFORE xterm's own wheel
    // handler (and beat the browser's page-zoom), so it's a capture-phase
    // listener on the host with preventDefault — returning false from xterm's
    // custom handler alone doesn't stop the native scroll/zoom, which let the
    // wheel-up (zoom-in) case leak through as a scrollback scroll.
    const onWheelCapture = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      applyFont((term.options.fontSize ?? FONT_DEFAULT) - Math.sign(e.deltaY), true);
    };
    const host = hostRef.current!;
    host.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });

    // Claude's TUI enables mouse tracking, so by default xterm forwards wheel
    // events to the app instead of scrolling its own scrollback — the terminal
    // feels "stuck". When we're in the normal buffer (Claude doesn't use the
    // alternate screen), intercept the wheel and scroll xterm's history
    // ourselves; otherwise fall through to default handling.
    term.attachCustomWheelEventHandler((e) => {
      if (e.ctrlKey || e.metaKey) return false; // handled by onWheelCapture
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
      // Font zoom: Ctrl/Cmd with +/=/-/0 (0 resets). Consume so xterm doesn't
      // send the keystroke to claude.
      const cur = term.options.fontSize ?? FONT_DEFAULT;
      if (key === "=" || key === "+") {
        applyFont(cur + 1, true);
        return false;
      }
      if (key === "-" || key === "_") {
        applyFont(cur - 1, true);
        return false;
      }
      if (key === "0") {
        applyFont(FONT_DEFAULT, true);
        return false;
      }
      if (key === "c" && (e.shiftKey || term.hasSelection())) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
        return false; // handled — don't also send ^C
      }
      if (key === "v") return false; // xterm hands-off → native paste event fires
      return true;
    });

    // Which agent this terminal runs (from its startup command) — decides the
    // screen-scan patterns and whether we tail a structured rollout log.
    const spec = agentOf(startup);

    // Resume the terminal's last claude conversation on cold start instead of
    // booting a fresh one. `resumeId` is only set for terminals restored from a
    // previous run (a brand-new tab has none → plain `startup`).
    const spawnCmd = resumeId ? resumeCommand(startup, resumeId) : startup;
    spawnSession(id, cwd, term.cols, term.rows, spawnCmd).catch((e) =>
      term.writeln(`\r\n[fleet] spawn error: ${e}`),
    );

    // "불러오기" on a session whose PTY already exited (live canvas / wakeTerm):
    // relaunch in place — same terminal, fresh shell (backend replaces the dead
    // session under the same id).
    const onRespawn = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      term.reset();
      spawnSession(id, cwd, term.cols, term.rows, spawnCmd).catch((err) =>
        term.writeln(`\r\n[fleet] spawn error: ${err}`),
      );
      // A respawn creates a NEW agent session (new rollout file) — rebind.
      if (spec.statusMode === "rollout") {
        unwatchAgentSession(id).catch(() => {});
        watchAgentSession(id, cwd, Date.now(), spec.rolloutDir || undefined).catch(() => {});
      }
    };
    window.addEventListener("fleet-respawn", onRespawn);

    // Screen-scan FALLBACK: read the visible viewport and decide busy/idle (and,
    // where known, blocked-on-approval) from what the agent's TUI is showing —
    // the "esc to interrupt" hint is present only while a turn runs. This is only
    // a fallback: structured status (Claude hooks, or the codex rollout watcher
    // below) overrides it in useFleet once those events start arriving.
    const busyRe = spec.screenBusyRe ?? /esc to interrupt/i;
    const scan = () => {
      const buf = term.buffer.active;
      let text = "";
      for (let r = 0; r < term.rows; r++) {
        text += (buf.getLine(buf.baseY + r)?.translateToString(true) ?? "") + "\n";
      }
      const status: TermStatus = spec.screenWaitingRe?.test(text)
        ? "waiting"
        : busyRe.test(text)
          ? "busy"
          : "idle";
      onStatus?.(id, status);
    };
    // "rollout" agents (codex): tail the session's structured event log so status
    // comes from real events, not the screen. Bound to this terminal by cwd +
    // spawn time in the backend; stopped on unmount below.
    if (spec.statusMode === "rollout") {
      watchAgentSession(id, cwd, Date.now(), spec.rolloutDir || undefined).catch(() => {});
    }
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

    // Alt-tab to another OS window (or minimize) while mid-composition: the pane
    // stays visible (so the visible=false reset never fires) AND the browser does
    // NOT blur the focused textarea when the whole WINDOW loses focus — it fires
    // `blur` on `window` only, and the textarea keeps focus. So neither existing
    // reset path runs, the IME run survives the switch, and the first Hangul
    // keystroke on return double-writes (stale run + resurrected composition,
    // plus Windows re-anchoring its IME indicator at the textarea's 0,0). Clear
    // the run on window blur too. reset() is a no-op when no run is active.
    const onWindowBlur = () => ime.reset();
    window.addEventListener("blur", onWindowBlur);

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
          // Force a full repaint of every visible row. After the FitAddon changes
          // the terminal's dimensions, the DOM renderer can leave stale row cells
          // behind — reflowed scrollback then reads as garbled when you scroll up.
          // Repainting the whole viewport clears that residue.
          term.refresh(0, term.rows - 1);
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
      window.removeEventListener(FONT_EVENT, onFontEvent);
      window.removeEventListener("fleet-theme", onThemeEvent);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("fleet-respawn", onRespawn);
      host.removeEventListener("wheel", onWheelCapture, { capture: true });
      unlistenOut.then((f) => f());
      unlistenExit.then((f) => f());
      if (spec.statusMode === "rollout") unwatchAgentSession(id).catch(() => {});
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
        if (termRef.current) {
          resizePty(id, termRef.current.cols, termRef.current.rows);
          termRef.current.refresh(0, termRef.current.rows - 1);
        }
        termRef.current?.focus();
      } catch {
        /* */
      }
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible, id]);

  return <div className="term-host" ref={hostRef} />;
}
