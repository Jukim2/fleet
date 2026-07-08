import { useEffect, useMemo, useRef, useState } from "react";
import { listClaudeSessions } from "../../api/claude";
import {
  ClaudeSession,
  LiveCanvas,
  LiveRect,
  LiveToolUse,
  PlanViewport,
  Project,
  SavedToolRun,
  Terminal,
  TermStatus,
  ToolJob,
} from "../../types";
import { ToolManifest, ToolValues } from "../../lib/tools";
import ToolRunModal from "../tools/ToolRunModal";
import { TermSlot } from "../terminals/termDock";
import "../tools/live.css";

export type LiveProps = {
  projects: Project[];
  terminals: Terminal[];
  statuses: Record<string, TermStatus>;
  activity: Record<string, string>;
  liveTool: Record<string, LiveToolUse>;
  toolJobs: Record<string, ToolJob>;
  manifests: Record<string, ToolManifest>;
  toolRoots: Record<string, string>;
  toolPresets: Record<string, Record<string, SavedToolRun>>;
  liveCanvas?: LiveCanvas;
  onPlaceFrames: (frames: Record<string, LiveRect>) => void;
  onRemoveFrame: (projectId: string) => void;
  onMoveNode: (termId: string, rect: LiveRect) => void;
  onSetCanvasView: (view: PlanViewport) => void;
  onSetSideW: (w: number) => void;
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
  onSetToolRoot: (manifestId: string, path: string) => void;
  onRunTool: (
    projectId: string,
    manifestId: string,
    mode: string,
    inputDir: string,
    values: ToolValues,
  ) => Promise<string | null>;
  onCancelTool: (jobId: string) => void;
  onDismissTool: (jobId: string) => void;
  onImportFiles: (jobId: string, files: string[], destSub: string) => Promise<void>;
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
const JOB_H = 84;
const FRAME_PAD = 14;
const FRAME_HEAD = 44;
const FRAME_MIN_W = 320;
const FRAME_MIN_H = 150;
const MIN_K = 0.3;
const MAX_K = 2.2;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
// left sidebar width (user-draggable, persisted)
const SIDE_MIN = 150;
const SIDE_MAX = 400;
const SIDE_DEFAULT = 180;
const clampSide = (w: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, w));

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
 * 저장된다. 왼쪽 목록에서 프로젝트를 캔버스로 꺼내오거나 다시 넣어둔다.
 */
export default function LiveView(p: LiveProps) {
  const { projects, terminals, statuses, liveTool, toolJobs, manifests, liveCanvas } = p;

  /** open tool GUI: fresh run for a project, or an existing job's progress/results */
  const [modal, setModal] = useState<{ projectId: string; manifestId: string; jobId?: string } | null>(
    null,
  );
  /** 사이드바 하단 세션 목록이 따라가는 선택된 프로젝트 (메인 화면의 프로젝트 선택과 동일 개념) */
  const [selectedPid, setSelectedPid] = useState<string | null>(null);
  /** 사이드바 가로폭 (드래그로 조절, liveCanvas.sideW에 저장) */
  const [sideW, setSideW] = useState<number>(() => clampSide(liveCanvas?.sideW ?? SIDE_DEFAULT));
  const startSideDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX;
    const base = sideW;
    const move = (ev: MouseEvent) => setSideW(clampSide(base + (ev.clientX - sx)));
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      p.onSetSideW(clampSide(base + (ev.clientX - sx)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
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

  const jobsByProject = useMemo(() => {
    const m: Record<string, ToolJob[]> = {};
    for (const j of Object.values(toolJobs)) (m[j.projectId] ??= []).push(j);
    for (const list of Object.values(m)) list.sort((a, b) => a.startedAt - b.startedAt);
    return m;
  }, [toolJobs]);

  // ---- frames: stored rects; first open auto-places live projects ----
  const storedFrames = liveCanvas?.frames;
  const placedIds = projects.filter((pr) => storedFrames?.[pr.id]).map((pr) => pr.id);
  const placedKey = placedIds.join("|");

  /** 사이드바 하단이 실제로 보여줄 프로젝트: 명시 선택 → 첫 배치 → 첫 프로젝트 */
  const effectivePid =
    (selectedPid && projects.some((pr) => pr.id === selectedPid) && selectedPid) ||
    placedIds[0] ||
    projects[0]?.id ||
    null;

  // ---- 기존 세션: resumable past conversations (dormant tabs live in the sidebar) ----
  /** past claude conversations per placed project (lazy-fetched, cached) */
  const [resumes, setResumes] = useState<Record<string, ClaudeSession[]>>({});
  useEffect(() => {
    // fetch for every placed project + the sidebar-selected one (may be unplaced)
    const need = [...placedIds, ...(effectivePid ? [effectivePid] : [])];
    for (const pid of need) {
      if (resumes[pid]) continue;
      const proj = projects.find((x) => x.id === pid);
      if (!proj) continue;
      listClaudeSessions(proj.path)
        .then((list) => setResumes((r) => ({ ...r, [pid]: list })))
        .catch(() => setResumes((r) => ({ ...r, [pid]: [] })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey, effectivePid]);
  /** resume rows, minus conversations already open as a terminal tab */
  const resumeRowsOf = (pid: string) => {
    const open = new Set(
      terminals
        .filter((t) => t.projectId === pid)
        .map((t) => /--resume (\S+)/.exec(t.startup)?.[1])
        .filter(Boolean),
    );
    return (resumes[pid] ?? []).filter((s) => !open.has(s.id));
  };

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
    const jobs = jobsByProject[pid] ?? [];
    let maxBottom = 0;
    let maxRight = NODE_W;
    terms.forEach((t, i) => {
      const r = nodeRect(t.id, i);
      const s = nodeSize(r);
      maxBottom = Math.max(maxBottom, r.y + s.h);
      maxRight = Math.max(maxRight, r.x + s.w + (liveTool[t.id] ? EDGE_W + TOOL_W : 0));
    });
    const jobsY = terms.length ? maxBottom + ROW_GAP : 0;
    if (jobs.length) {
      maxBottom = jobsY + jobs.length * JOB_H;
      maxRight = Math.max(maxRight, 450);
    }
    const empty = terms.length === 0 && jobs.length === 0;
    const stored = frameRect(pid);
    const contentW = maxRight + FRAME_PAD * 2;
    const contentH = FRAME_HEAD + (empty ? 64 : maxBottom + FRAME_PAD * 2);
    return {
      w: Math.max(FRAME_MIN_W, contentW, stored?.w ?? 0),
      h: Math.max(FRAME_MIN_H, contentH, stored?.h ?? 0),
      jobsY,
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

  // fit all placed frames into view
  const fitView = () => {
    const r = canvasRef.current?.getBoundingClientRect();
    const placed = Object.keys(storedFrames ?? {});
    if (!r || placed.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pid of placed) {
      const rect = frameRect(pid)!;
      const g = frameGeom(pid);
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + g.w);
      maxY = Math.max(maxY, rect.y + g.h);
    }
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

  // place a project's frame near the current view center if it isn't already up
  const ensurePlaced = (pid: string) => {
    if (storedFrames?.[pid]) return;
    const r = canvasRef.current?.getBoundingClientRect();
    const c = toWorld((r?.left ?? 0) + (r?.width ?? 800) / 2, (r?.top ?? 0) + (r?.height ?? 500) / 2);
    p.onPlaceFrames({ [pid]: { x: c.x - 200, y: c.y - 120 } });
  };
  // sidebar ◉/○ toggle: put a project's frame on the canvas or take it back
  const togglePlace = (pid: string) => {
    if (storedFrames?.[pid]) p.onRemoveFrame(pid);
    else ensurePlaced(pid);
  };
  // sidebar list actions: bring a session onto the canvas as a node
  const openSession = (pid: string, termId: string) => {
    ensurePlaced(pid);
    p.onWakeTerm(termId);
  };
  const resumeSession = (pid: string, s: ClaudeSession) => {
    ensurePlaced(pid);
    p.onResumeSession(pid, s);
  };

  const modalProject = modal ? projects.find((x) => x.id === modal.projectId) : null;
  const modalManifest = modal ? manifests[modal.manifestId] : null;

  // ---- sidebar bottom: sessions of the selected project (main-view style) ----
  const selProj = projects.find((pr) => pr.id === effectivePid) ?? null;
  const selTerms = selProj
    ? terminals
        .filter((t) => t.projectId === selProj.id)
        .sort((a, b) => {
          // live first, then dormant; stable-ish by title
          const la = statuses[a.id] && statuses[a.id] !== "stopped" ? 0 : 1;
          const lb = statuses[b.id] && statuses[b.id] !== "stopped" ? 0 : 1;
          return la - lb;
        })
    : [];
  const selResumes = selProj ? resumeRowsOf(selProj.id) : [];

  return (
    <div className="lv2">
      {/* ---- left shelf: projects (top) + selected project's sessions (bottom),
              mirroring the main view's project→session layout ---- */}
      <aside
        className="lv2-side"
        style={{ flexBasis: sideW, width: sideW }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="lv2-side-title">프로젝트</div>
        <div className="lv2-side-list">
          {projects.map((pr) => {
            const placed = !!storedFrames?.[pr.id];
            const liveN = (liveTermsOf[pr.id] ?? []).length;
            const sel = pr.id === effectivePid;
            return (
              <div
                key={pr.id}
                className={`lv2-side-item ${sel ? "sel" : ""} ${placed ? "on" : ""}`}
                onClick={() => {
                  setSelectedPid(pr.id);
                  ensurePlaced(pr.id);
                }}
                title="클릭해서 선택 (하단에 세션 목록)"
              >
                <span className="lv2-side-name">{pr.name}</span>
                {liveN > 0 && <span className="lv2-side-live">{liveN}</span>}
                <button
                  className="lv2-side-mark"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlace(pr.id);
                  }}
                  title={placed ? "캔버스에서 빼기" : "캔버스로 꺼내오기"}
                >
                  {placed ? "◉" : "○"}
                </button>
              </div>
            );
          })}
        </div>

        {/* ---- selected project's sessions: live + dormant + resumable ---- */}
        {selProj && (
          <div className="lv2-side-sess">
            <div className="lv2-side-sess-head">
              <span className="lv2-side-sess-title">{selProj.name} · 세션</span>
              <button
                className="lv2-side-new"
                onClick={() => p.onNewSession(selProj.id)}
                title="새 claude 세션"
              >
                ＋ 세션
              </button>
              <button
                className="lv2-side-new"
                onClick={() => p.onNewShell(selProj.id)}
                title="새 셸(순수 터미널)"
              >
                ＋ 셸
              </button>
            </div>
            <div className="lv2-side-sess-list">
              {selTerms.length === 0 && selResumes.length === 0 && (
                <div className="lv2-side-sess-empty">세션 없음 — ＋로 시작</div>
              )}
              {selTerms.map((t) => {
                const st = statuses[t.id];
                const live = st && st !== "stopped";
                const shell = isShellTerm(t);
                return (
                  <div className="lv2-sess" key={t.id}>
                    <button
                      className="lv2-sess-main"
                      onClick={() => openSession(selProj.id, t.id)}
                      title={live ? "캔버스에서 보기" : "불러오기 — 캔버스에 띄우기"}
                    >
                      <span className={`lv-dot ${live ? st : "stopped"}`} />
                      <span className="lv2-sess-name">{t.title}</span>
                      <span className={`lv2-sess-kind ${shell ? "shell" : "claude"}`}>
                        {shell ? "셸" : "claude"}
                      </span>
                      <span className="lv2-sess-act">{live ? "보기" : "불러오기"}</span>
                    </button>
                    <button
                      className="lv2-sess-x"
                      onClick={() => p.onCloseTerm(selProj.id, t.id)}
                      title="세션 닫기 (터미널 탭 삭제)"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              {selResumes.map((s) => (
                <div className="lv2-sess" key={s.id}>
                  <button
                    className="lv2-sess-main"
                    onClick={() => resumeSession(selProj.id, s)}
                    title={`이어하기 — 이 대화를 새 세션으로 재개\n${s.summary}`}
                  >
                    <span className="lv2-sess-resume">↺</span>
                    <span className="lv2-sess-name">{s.summary || "(빈 대화)"}</span>
                    <span className="lv2-sess-act">이어하기</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          className="lv2-side-resize"
          onMouseDown={startSideDrag}
          title="드래그해서 사이드바 너비 조절"
        />
      </aside>

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
            const jobs = jobsByProject[pid] ?? [];
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
                  {Object.values(manifests).map((m) => (
                    <button
                      key={m.id}
                      className="lv2-frame-btn"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => setModal({ projectId: pid, manifestId: m.id })}
                      title={`${m.name} 실행 (GUI)`}
                    >
                      ＋ {m.name}
                    </button>
                  ))}
                  <button
                    className="lv2-frame-btn x"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => p.onRemoveFrame(pid)}
                    title="캔버스에서 빼기 (왼쪽 목록으로)"
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
                          <>
                            <span className="lv-edge live" style={{ flexBasis: EDGE_W }} />
                            <div
                              className="lv-node tool claude"
                              style={{ width: TOOL_W }}
                              title={use.detail}
                            >
                              <span className="lv-tool-name">{useManifest.name}</span>
                              <span className="lv-tool-detail">
                                {use.detail.length > 52 ? use.detail.slice(0, 52) + "…" : use.detail}
                              </span>
                              <span className="lv-tool-tag">
                                세션이 구동 중 · {fmtElapsed(now - use.at)}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}

                  {jobs.map((j, i) => {
                    const m = manifests[j.manifestId];
                    const modeLabel = m?.modes.find((x) => x.id === j.mode)?.label ?? j.mode;
                    const running = j.status === "running";
                    const pct = j.total
                      ? Math.min(100, Math.round(((j.done + j.failed) / j.total) * 100))
                      : null;
                    return (
                      <div
                        className="lv2-row"
                        key={j.id}
                        style={{ left: 0, top: g.jobsY + i * JOB_H }}
                      >
                        <button
                          className={`lv-node tool job ${j.status}`}
                          style={{ width: 420 }}
                          onClick={() =>
                            setModal({ projectId: pid, manifestId: j.manifestId, jobId: j.id })
                          }
                          title="클릭: 진행 상황 / 결과 보기"
                        >
                          <span className="lv2-job-head">
                            <span className="lv-fleet-badge">Fleet</span>
                            <span className="lv-tool-name">
                              {m?.name ?? j.manifestId} · {modeLabel}
                            </span>
                          </span>
                          <span className="lv-job-bar">
                            <span
                              className={`lv-job-fill ${running && pct === null ? "indet" : ""} ${
                                j.status === "error" ? "err" : ""
                              }`}
                              style={pct !== null ? { width: `${pct}%` } : undefined}
                            />
                          </span>
                          <span className="lv-tool-tag">
                            {running
                              ? `${j.done}${j.total ? `/${j.total}` : ""} 처리 · ${fmtElapsed(now - j.startedAt)}`
                              : j.status === "done"
                                ? `완료 · ${j.done}개 처리 — 클릭해 결과 보기`
                                : j.status === "killed"
                                  ? "중단됨"
                                  : "실패 — 클릭해 로그 확인"}
                          </span>
                        </button>
                        {running ? (
                          <button className="lv-job-x" onClick={() => p.onCancelTool(j.id)} title="중단">
                            ■
                          </button>
                        ) : (
                          <button className="lv-job-x" onClick={() => p.onDismissTool(j.id)} title="제거">
                            ✕
                          </button>
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
              왼쪽 목록에서 프로젝트를 클릭해 캔버스로 꺼내오세요.
            </div>
          )}
        </div>

        {/* zoom / fit controls */}
        <div className="lv2-zoom" onMouseDown={(e) => e.stopPropagation()}>
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
          <button className="plan-zoom-btn fit" onClick={fitView} title="전체 보기">
            ⤢
          </button>
        </div>
      </div>

      {modal && modalProject && modalManifest && (
        <ToolRunModal
          project={modalProject}
          manifest={modalManifest}
          toolRoot={p.toolRoots[modalManifest.id]}
          preset={p.toolPresets[modalProject.id]?.[modalManifest.id]}
          toolJobs={toolJobs}
          initialJobId={modal.jobId}
          onSetToolRoot={p.onSetToolRoot}
          onRun={(mode, inputDir, values) =>
            p.onRunTool(modalProject.id, modalManifest.id, mode, inputDir, values)
          }
          onCancel={p.onCancelTool}
          onImport={p.onImportFiles}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
