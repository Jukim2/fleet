import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listToolOutputs, ToolFile } from "../../api/tools";
import { openPath } from "../../api/system";
import {
  ClaudeSession,
  LiveCanvas,
  LiveRect,
  LiveToolUse,
  PlanViewport,
  Project,
  Terminal,
  TermStatus,
} from "../../types";
import { ToolManifest } from "../../lib/tools";
import { TermSlot } from "../terminals/termDock";
import "../tools/live.css";

export type LiveProps = {
  projects: Project[];
  terminals: Terminal[];
  statuses: Record<string, TermStatus>;
  activity: Record<string, string>;
  liveTool: Record<string, LiveToolUse>;
  manifests: Record<string, ToolManifest>;
  liveCanvas?: LiveCanvas;
  onPlaceFrames: (frames: Record<string, LiveRect>) => void;
  onRemoveFrame: (projectId: string) => void;
  onMoveNode: (termId: string, rect: LiveRect) => void;
  onSetCanvasView: (view: PlanViewport) => void;
  onSetSideW: (w: number) => void;
  /** 메인 레일에서 선택한 프로젝트 — 캔버스에서 해당 프레임을 배치·중앙 정렬한다 */
  focusPid?: string | null;
  onNewSession: (projectId: string) => void;
  /** 새 셸 세션(순수 터미널) 열기 */
  onNewShell: (projectId: string) => void;
  /** 세션 목록의 "불러오기" — spawn/relaunch a dormant terminal so it becomes a node */
  onWakeTerm: (termId: string) => void;
  /** 세션 목록의 "이어하기" — resume a past claude conversation in this project */
  onResumeSession: (projectId: string, session: ClaudeSession) => void;
  /** 세션 닫기 (터미널 탭 삭제) */
  onCloseTerm: (projectId: string, termId: string) => void;
  onJumpTerm: (projectId: string, termId: string) => void;
  /** 세션이 구동한 라이브 툴 노드를 수동으로 닫기 */
  onDismissLiveTool: (termId: string) => void;
};

const STATUS_LABEL: Record<TermStatus, string> = {
  busy: "작업 중",
  waiting: "승인 필요",
  idle: "대기",
  stopped: "종료",
};

/** 셸 세션 판별: startup이 claude로 시작하지 않으면 순수 셸(빈 startup 포함). */
const isShellTerm = (t: Terminal) => !t.startup.trim().startsWith("claude");

// canvas geometry (world units). Session nodes and frames carry a user-resized
// w/h (persisted); absent = these defaults, and a frame never shrinks below its
// content (resizing smaller just snaps back to the content bound). Session
// nodes host the REAL terminal (mini claude pane), so they default roomy.
const NODE_W = 460;
const NODE_H = 300;
const NODE_MIN_W = 340;
const NODE_MAX_W = 1100;
const NODE_MIN_H = 200;
const NODE_MAX_H = 800;
const TOOL_W = 280;
const EDGE_W = 30;
const ROW_GAP = 16;
const FRAME_PAD = 14;
const FRAME_HEAD = 44;
const FRAME_MIN_W = 320;
const FRAME_MIN_H = 150;
const MIN_K = 0.3;
const MAX_K = 2.2;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
};

type Pos = { x: number; y: number };

/**
 * 라이브 커맨드센터 캔버스. 프로젝트가 점선 프레임(큰 틀)으로 놓이고, 그 안에
 * 살아있는 claude 세션 노드(상시 입력창 포함)와 툴 노드가 들어간다. 프레임·세션
 * 노드는 드래그로 배치하고 우하단 핸들로 크기를 조절하며, 배치·크기·뷰포트는 모두
 * 저장된다. 메인 레일에서 프로젝트를 클릭하면 캔버스로 올라오고, 프레임 헤더 ✕로 다시 내린다.
 */
export default function LiveView(p: LiveProps) {
  const { projects, terminals, statuses, liveTool, manifests, liveCanvas } = p;

  // 1s tick for elapsed clocks
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ---- viewport (pan + zoom), persisted debounced ----
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<PlanViewport>(liveCanvas?.view ?? { x: 24, y: 24, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => p.onSetCanvasView(view), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const toWorld = (clientX: number, clientY: number): Pos => {
    const r = canvasRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - (r?.left ?? 0) - v.x) / v.k, y: (clientY - (r?.top ?? 0) - v.y) / v.k };
  };

  // ---- live content per project ----
  const liveTermsOf = useMemo(() => {
    const m: Record<string, Terminal[]> = {};
    for (const t of terminals) {
      const st = statuses[t.id];
      if (st && st !== "stopped") (m[t.projectId] ??= []).push(t);
    }
    return m;
  }, [terminals, statuses]);

  // ---- frames: stored rects; first open auto-places live projects ----
  const storedFrames = liveCanvas?.frames;
  const placedIds = projects.filter((pr) => storedFrames?.[pr.id]).map((pr) => pr.id);
  const placedKey = placedIds.join("|");

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current || storedFrames !== undefined) return;
    initRef.current = true;
    const auto: Record<string, LiveRect> = {};
    let i = 0;
    for (const pr of projects) {
      if ((liveTermsOf[pr.id] ?? []).length === 0) continue;
      auto[pr.id] = { x: 40 + (i % 2) * 780, y: 40 + Math.floor(i / 2) * 480 };
      i++;
    }
    p.onPlaceFrames(auto); // materialize (possibly {}) so this runs once ever
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedFrames]);

  /** ephemeral drag/resize override so config isn't written per mousemove */
  const [ghost, setGhost] = useState<{ kind: "frame" | "node"; id: string; rect: LiveRect } | null>(
    null,
  );
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;

  const frameRect = (pid: string): LiveRect | undefined => {
    const g = ghostRef.current;
    if (g?.kind === "frame" && g.id === pid) return g.rect;
    return storedFrames?.[pid];
  };
  const nodeRect = (termId: string, index: number): LiveRect => {
    const g = ghostRef.current;
    if (g?.kind === "node" && g.id === termId) return g.rect;
    return liveCanvas?.nodes?.[termId] ?? { x: 0, y: index * (NODE_H + ROW_GAP) };
  };
  const nodeSize = (r: LiveRect) => ({
    w: Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, r.w ?? NODE_W)),
    h: Math.min(NODE_MAX_H, Math.max(NODE_MIN_H, r.h ?? NODE_H)),
  });

  // ---- geometry of one frame (world size), derived from its rows ----
  const frameGeom = (pid: string) => {
    const terms = liveTermsOf[pid] ?? [];
    let maxBottom = 0;
    let maxRight = NODE_W;
    terms.forEach((t, i) => {
      const r = nodeRect(t.id, i);
      const s = nodeSize(r);
      maxBottom = Math.max(maxBottom, r.y + s.h);
      maxRight = Math.max(maxRight, r.x + s.w + (liveTool[t.id] ? EDGE_W + TOOL_W : 0));
    });
    const empty = terms.length === 0;
    const stored = frameRect(pid);
    const contentW = maxRight + FRAME_PAD * 2;
    const contentH = FRAME_HEAD + (empty ? 64 : maxBottom + FRAME_PAD * 2);
    return {
      w: Math.max(FRAME_MIN_W, contentW, stored?.w ?? 0),
      h: Math.max(FRAME_MIN_H, contentH, stored?.h ?? 0),
      empty,
    };
  };

  // ---- pointer interactions: pan / drag / resize ----
  const panDrag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const moving = useRef<{ kind: "frame" | "node"; id: string; dx: number; dy: number } | null>(null);
  const sizing = useRef<{
    kind: "frame" | "node";
    id: string;
    base: LiveRect;
    sx: number;
    sy: number;
  } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (panDrag.current) {
        const d = panDrag.current;
        setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
        return;
      }
      if (moving.current) {
        const d = moving.current;
        const w = toWorld(e.clientX, e.clientY);
        const cur = ghostRef.current?.rect;
        const x = d.kind === "node" ? Math.max(0, w.x - d.dx) : w.x - d.dx;
        const y = d.kind === "node" ? Math.max(0, w.y - d.dy) : w.y - d.dy;
        setGhost({ kind: d.kind, id: d.id, rect: { ...(cur ?? {}), x, y, w: cur?.w, h: cur?.h } });
        return;
      }
      if (sizing.current) {
        const d = sizing.current;
        const k = viewRef.current.k;
        const dw = (e.clientX - d.sx) / k;
        const dh = (e.clientY - d.sy) / k;
        const baseW = d.base.w ?? (d.kind === "node" ? NODE_W : 0);
        const baseH = d.base.h ?? (d.kind === "node" ? NODE_H : 0);
        setGhost({
          kind: d.kind,
          id: d.id,
          rect: {
            x: d.base.x,
            y: d.base.y,
            w: Math.max(d.kind === "node" ? NODE_MIN_W : FRAME_MIN_W, baseW + dw),
            h: Math.max(d.kind === "node" ? NODE_MIN_H : FRAME_MIN_H, baseH + dh),
          },
        });
      }
    };
    const up = () => {
      if (panDrag.current) {
        panDrag.current = null;
        setPanning(false);
      }
      const g = ghostRef.current;
      if (g && (moving.current || sizing.current)) {
        if (g.kind === "frame") p.onPlaceFrames({ [g.id]: g.rect });
        else p.onMoveNode(g.id, g.rect);
      }
      moving.current = null;
      sizing.current = null;
      setGhost(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // wheel zoom toward the cursor. Over a docked terminal the wheel belongs to
  // xterm (scrollback / Ctrl+wheel font zoom), not the canvas.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.(".term-dock")) return;
      const ta = (e.target as HTMLElement).closest?.("textarea");
      if (ta && ta.scrollHeight > ta.clientHeight) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const k = clampK(v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        const wx = (px - v.x) / v.k;
        const wy = (py - v.y) / v.k;
        return { k, x: px - wx * k, y: py - wy * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const startPan = (e: { clientX: number; clientY: number }) => {
    panDrag.current = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
    setPanning(true);
  };
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const onBg = t === canvasRef.current || t.classList.contains("lv2-world");
    if (e.button === 2 || e.button === 1 || (e.button === 0 && onBg)) {
      startPan(e);
      e.preventDefault();
    }
  };

  const startMove = (e: React.MouseEvent, kind: "frame" | "node", id: string, rect: LiveRect) => {
    if (e.button !== 0) return;
    const w = toWorld(e.clientX, e.clientY);
    moving.current = { kind, id, dx: w.x - rect.x, dy: w.y - rect.y };
    setGhost({ kind, id, rect });
    e.preventDefault();
    e.stopPropagation();
  };
  const startResize = (e: React.MouseEvent, kind: "frame" | "node", id: string, base: LiveRect) => {
    if (e.button !== 0) return;
    sizing.current = { kind, id, base, sx: e.clientX, sy: e.clientY };
    setGhost({ kind, id, rect: base });
    e.preventDefault();
    e.stopPropagation();
  };

  // pan+zoom so a world-space bounding box sits centered with padding
  const fitToBounds = (minX: number, minY: number, maxX: number, maxY: number) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return;
    const pad = 48;
    const k = clampK(
      Math.min((r.width - pad) / (maxX - minX || 1), (r.height - pad) / (maxY - minY || 1), 1.2),
    );
    setView({
      k,
      x: (r.width - (maxX - minX) * k) / 2 - minX * k,
      y: (r.height - (maxY - minY) * k) / 2 - minY * k,
    });
  };

  // fit all placed frames into view
  const fitView = () => {
    const placed = Object.keys(storedFrames ?? {});
    if (placed.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pid of placed) {
      const rect = frameRect(pid)!;
      const g = frameGeom(pid);
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + g.w);
      maxY = Math.max(maxY, rect.y + g.h);
    }
    fitToBounds(minX, minY, maxX, maxY);
  };

  // ---- 정렬 (auto-arrange) ----
  const ARRANGE_GAP = 40;
  // 프로젝트간 정렬: 배치된 프레임들을 프로젝트 순서대로 좌상단부터 격자로 재배치.
  const arrangeFrames = () => {
    const ordered = projects.filter((pr) => storedFrames?.[pr.id]).map((pr) => pr.id);
    if (ordered.length === 0) return;
    const cols = Math.ceil(Math.sqrt(ordered.length));
    const next: Record<string, LiveRect> = {};
    let x = 40, y = 40, rowH = 0;
    let maxX = 40, maxY = 40;
    ordered.forEach((pid, i) => {
      const g = frameGeom(pid);
      const st = storedFrames?.[pid];
      next[pid] = { x, y, w: st?.w, h: st?.h }; // keep any user-resized w/h
      maxX = Math.max(maxX, x + g.w);
      maxY = Math.max(maxY, y + g.h);
      rowH = Math.max(rowH, g.h);
      if ((i + 1) % cols === 0) {
        x = 40;
        y += rowH + ARRANGE_GAP;
        rowH = 0;
      } else {
        x += g.w + ARRANGE_GAP;
      }
    });
    p.onPlaceFrames(next);
    fitToBounds(40, 40, maxX, maxY); // we know the arranged bounds — fit now
  };

  // 프로젝트 내부 정렬: 한 프레임의 세션 노드를 격자로 재배치 (크기는 보존).
  const arrangeNodesIn = (pid: string) => {
    const terms = liveTermsOf[pid] ?? [];
    if (terms.length === 0) return;
    const cols = Math.ceil(Math.sqrt(terms.length));
    let x = 0, y = 0, rowH = 0;
    terms.forEach((t, i) => {
      const cur = liveCanvas?.nodes?.[t.id];
      const s = nodeSize(cur ?? { x: 0, y: 0 });
      const w = s.w + (liveTool[t.id] ? EDGE_W + TOOL_W : 0); // reserve tool sidecar
      p.onMoveNode(t.id, { x, y, w: cur?.w, h: cur?.h });
      rowH = Math.max(rowH, s.h);
      if ((i + 1) % cols === 0) {
        x = 0;
        y += rowH + ROW_GAP;
        rowH = 0;
      } else {
        x += w + ROW_GAP;
      }
    });
  };

  // place a project's frame near the current view center if it isn't already up
  const ensurePlaced = (pid: string) => {
    if (storedFrames?.[pid]) return;
    const r = canvasRef.current?.getBoundingClientRect();
    const c = toWorld((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 500) / 2);
    p.onPlaceFrames({ [pid]: { x: c.x - 200, y: c.y - 120 } });
  };
  // pan the viewport so a placed project's frame sits centered (keeps zoom)
  const centerFrame = (pid: string) => {
    const r = canvasRef.current?.getBoundingClientRect();
    const rect = frameRect(pid);
    if (!r || !rect) return;
    const g = frameGeom(pid);
    const k = viewRef.current.k;
    setView({ k, x: r.width / 2 - (rect.x + g.w / 2) * k, y: r.height / 2 - (rect.y + g.h / 2) * k });
  };

  // The main rail (shared with the main view) drives the canvas now — there's no
  // in-canvas project shelf. Selecting a project places its frame and pans to it.
  // Skip the initial value so entering the live view keeps the saved viewport;
  // placement round-trips through config, so defer centering to when the frame
  // actually appears (tracked via pendingCenter + the placedKey effect).
  const { focusPid } = p;
  const firstFocus = useRef(true);
  const pendingCenter = useRef<string | null>(null);
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    if (!focusPid) return;
    if (storedFrames?.[focusPid]) centerFrame(focusPid);
    else {
      pendingCenter.current = focusPid;
      ensurePlaced(focusPid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPid]);
  useEffect(() => {
    const pid = pendingCenter.current;
    if (pid && storedFrames?.[pid]) {
      pendingCenter.current = null;
      centerFrame(pid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey]);

  // 입력 중이 아닐 때 Space → 전체 보기(fit). 폼/버튼 포커스(터미널 textarea 포함) 시엔 무시.
  const fitRef = useRef(fitView);
  fitRef.current = fitView;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || el?.isContentEditable)
        return;
      e.preventDefault();
      fitRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="lv2">
      {/* ---- canvas ---- */}
      <div
        className={`lv2-canvas ${panning ? "panning" : ""}`}
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className="lv2-world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          {placedIds.map((pid) => {
            const pr = projects.find((x) => x.id === pid)!;
            const rect = frameRect(pid)!;
            const g = frameGeom(pid);
            const terms = liveTermsOf[pid] ?? [];
            return (
              <section
                key={pid}
                className="lv2-frame"
                style={{ left: rect.x, top: rect.y, width: g.w, height: g.h }}
              >
                <header
                  className="lv2-frame-head"
                  onMouseDown={(e) => startMove(e, "frame", pid, rect)}
                  title="드래그해서 이동"
                >
                  <span className="lv2-frame-name">{pr.name}</span>
                  {terms.length > 0 && <span className="lv2-frame-count">세션 {terms.length}</span>}
                  <span className="lv2-frame-spacer" />
                  {terms.length > 0 && (
                    <button
                      className="lv2-frame-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => arrangeNodesIn(pid)}
                      title="이 프로젝트의 세션 노드를 격자로 정렬"
                    >
                      ▦ 정렬
                    </button>
                  )}
                  <button
                    className="lv2-frame-btn"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => p.onNewSession(pid)}
                    title="새 claude 세션 열기"
                  >
                    ＋ 세션
                  </button>
                  <button
                    className="lv2-frame-btn"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => p.onNewShell(pid)}
                    title="새 셸(순수 터미널) 열기"
                  >
                    ＋ 셸
                  </button>
                  <button
                    className="lv2-frame-btn x"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => p.onRemoveFrame(pid)}
                    title="이 프레임을 캔버스에서 내리기"
                  >
                    ✕
                  </button>
                </header>

                <div className="lv2-frame-body">
                  {g.empty && (
                    <div className="lv2-frame-empty">살아있는 세션 없음 — ＋ 세션으로 시작</div>
                  )}

                  {terms.map((t, i) => {
                    const st = statuses[t.id]!;
                    const nr = nodeRect(t.id, i);
                    const ns = nodeSize(nr);
                    const use = liveTool[t.id];
                    const useManifest = use ? manifests[use.manifestId] : null;
                    return (
                      <div className="lv2-row" key={t.id} style={{ left: nr.x, top: nr.y }}>
                        <div
                          className={`lv-node session ${st}`}
                          style={{ width: ns.w, height: ns.h }}
                        >
                          <div
                            className="lv2-node-drag"
                            onMouseDown={(e) => startMove(e, "node", t.id, nr)}
                            title="드래그해서 배치"
                          >
                            <span className={`lv-dot ${st}`} />
                            <span className="lv-node-title">{t.title}</span>
                            {isShellTerm(t) && <span className="lv-node-kind">셸</span>}
                            <span className={`lv-node-state ${st}`}>
                              {isShellTerm(t) ? "셸" : STATUS_LABEL[st]}
                            </span>
                            <button
                              className="lv2-node-btn"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() => p.onJumpTerm(pid, t.id)}
                              title="터미널로 이동"
                            >
                              열기 ↗
                            </button>
                            <button
                              className="lv2-node-btn x"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() => p.onCloseTerm(pid, t.id)}
                              title="세션 닫기 (터미널 탭 삭제)"
                            >
                              ✕
                            </button>
                          </div>
                          {/* 진짜 터미널(같은 xterm DOM)이 여기로 도킹된다 —
                              대화 내용·입력·IME·파일드롭 전부 본편 그대로 */}
                          <div
                            className="lv2-node-term"
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <TermSlot
                              termId={t.id}
                              slotKey="live"
                              priority={2}
                              active
                            />
                          </div>
                          <span
                            className="lv2-resize node"
                            onMouseDown={(e) => startResize(e, "node", t.id, nr)}
                            title="드래그해서 크기 조절"
                          />
                        </div>
                        {use && useManifest && (
                          <LiveToolNode
                            use={use}
                            manifest={useManifest}
                            busy={st === "busy"}
                            now={now}
                            onDismiss={() => p.onDismissLiveTool(t.id)}
                          />
                        )}
                      </div>
                    );
                  })}

                </div>

                <span
                  className="lv2-resize frame"
                  onMouseDown={(e) => startResize(e, "frame", pid, { ...rect, w: g.w, h: g.h })}
                  title="드래그해서 크기 조절"
                />
              </section>
            );
          })}

          {placedIds.length === 0 && (
            <div className="lv2-hint" style={{ left: 60, top: 60 }}>
              왼쪽 사이드바에서 프로젝트를 클릭하면 이 캔버스에 올라와요.
            </div>
          )}
        </div>

        {/* zoom / fit controls */}
        <div className="lv2-zoom" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="plan-zoom-btn"
            onClick={arrangeFrames}
            title="프로젝트 프레임을 격자로 정렬"
          >
            ▦
          </button>
          <button
            className="plan-zoom-btn"
            onClick={() => setView((v) => ({ ...v, k: clampK(v.k / 1.2) }))}
          >
            －
          </button>
          <button className="plan-zoom-val" onClick={() => setView((v) => ({ ...v, k: 1 }))}>
            {Math.round(view.k * 100)}%
          </button>
          <button
            className="plan-zoom-btn"
            onClick={() => setView((v) => ({ ...v, k: clampK(v.k * 1.2) }))}
          >
            ＋
          </button>
          <button className="plan-zoom-btn fit" onClick={fitView} title="전체 보기 (Space)">
            ⤢
          </button>
        </div>
      </div>
    </div>
  );
}

/** split a command string into tokens, respecting quotes */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
/** By the tool contract the argv is `program … <inputDir> --tool <mode> …`, so
 *  the input folder is the token right before `--tool`. Best-effort: the hook
 *  detail is truncated to 140 chars, so a very long path may not survive. */
function parseInputDir(detail: string): string | null {
  const toks = tokenize(detail);
  const ti = toks.indexOf("--tool");
  return ti > 0 ? toks[ti - 1] : null;
}
function joinPath(dir: string, sub: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + sub;
}

/**
 * The tool node hanging off a claude session node (path B: the session drove a
 * known tool, seen via the PreToolUse hook). It stays pinned after the turn ends
 * — dismissed only by its ✕ or when the terminal stops — and once the run
 * settles it best-effort scans the tool's output folder to show result thumbs.
 */
function LiveToolNode({
  use,
  manifest,
  busy,
  now,
  onDismiss,
}: {
  use: LiveToolUse;
  manifest: ToolManifest;
  busy: boolean;
  now: number;
  onDismiss: () => void;
}) {
  const [outs, setOuts] = useState<ToolFile[] | null>(null);
  const [input, setInput] = useState<ToolFile | null>(null);
  const inputDir = useMemo(() => parseInputDir(use.detail), [use.detail]);
  const outDir = inputDir ? joinPath(inputDir, manifest.outDirName) : null;

  // once the session settles, scan output dir for this run's results and the
  // input dir for a representative "before" image (a before→after pair)
  useEffect(() => {
    if (busy || !outDir || !inputDir) return;
    let alive = true;
    listToolOutputs(outDir, use.at - 5000)
      .then((fs) => alive && setOuts(fs))
      .catch(() => alive && setOuts([]));
    listToolOutputs(inputDir, 0)
      .then((fs) => alive && setInput(fs[0] ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [busy, outDir, inputDir, use.at]);

  const firstOut = outs?.[0] ?? null;
  const restOut = (outs ?? []).slice(1, 9);
  const tag = busy
    ? `세션이 구동 중 · ${fmtElapsed(now - use.at)}`
    : outs === null
      ? "완료 · 결과 확인 중…"
      : outs.length
        ? `완료 · 결과 ${outs.length}개`
        : "완료";

  return (
    <>
      <span className={`lv-edge ${busy ? "live" : ""}`} style={{ flexBasis: EDGE_W }} />
      <div className="lv-node tool claude" style={{ width: TOOL_W }} title={use.detail}>
        <div className="lv-tool-head">
          <span className="lv-tool-name">{manifest.name}</span>
          <button className="lv-tool-x" onClick={onDismiss} title="이 노드 닫기">
            ✕
          </button>
        </div>
        <span className="lv-tool-detail">
          {use.detail.length > 52 ? use.detail.slice(0, 52) + "…" : use.detail}
        </span>
        <span className="lv-tool-tag">{tag}</span>

        {/* representative before → after pair */}
        {firstOut && (
          <div className="lv-tool-pair">
            {input && (
              <>
                <button
                  className="lv-tool-big"
                  title={`입력: ${input.name} — 클릭해서 열기`}
                  onClick={() => openPath(input.path)}
                >
                  <img src={convertFileSrc(input.path)} alt={input.name} loading="lazy" />
                  <span className="lv-tool-big-tag">입력</span>
                </button>
                <span className="lv-tool-pair-arrow">→</span>
              </>
            )}
            <button
              className="lv-tool-big"
              title={`결과: ${firstOut.name} — 클릭해서 열기`}
              onClick={() => openPath(firstOut.path)}
            >
              <img src={convertFileSrc(firstOut.path)} alt={firstOut.name} loading="lazy" />
              <span className="lv-tool-big-tag out">결과</span>
            </button>
          </div>
        )}
        {restOut.length > 0 && (
          <div className="lv-tool-thumbs">
            {restOut.map((f) => (
              <button
                key={f.path}
                className="lv-tool-thumb"
                title={`${f.rel} — 클릭해서 열기`}
                onClick={() => openPath(f.path)}
              >
                <img src={convertFileSrc(f.path)} alt={f.name} loading="lazy" />
              </button>
            ))}
            {outs && outs.length - 1 > restOut.length && outDir && (
              <button
                className="lv-tool-more"
                onClick={() => openPath(outDir)}
                title="결과 폴더 열기"
              >
                +{outs.length - 1 - restOut.length}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
