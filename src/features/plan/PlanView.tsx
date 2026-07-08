import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  Note,
  Plan,
  PlanDir,
  PlanFeature,
  PlanSort,
  PlanStep,
  PlanViewport,
  Project,
  QueueBoard,
  TaskStatus,
  Terminal,
  TermStatus,
} from "../../types";
import NotesPanel from "./NotesPanel";
import { gitIsRepo } from "../../api/git";
import { openPath } from "../../api/system";
import { laneLiveTerm } from "../../lib/board";
import { ClaudeEffort, RunTarget } from "../../lib/plan";
import { criticalPath, layoutPlan } from "../../lib/planLayout";
import { PHASE_LABEL, WtFix, WtLogEntry, WtPhase, WtRun, WtStep, wtProgress } from "../../lib/worktree";
import "./plan.css";

type StepState = "done" | "running" | "ready" | "blocked";
function stepState(s: PlanStep, ts: Record<string, TaskStatus>): StepState {
  if (ts[s.id] === "done") return "done";
  if (ts[s.id] === "running") return "running";
  return s.deps.every((d) => ts[d] === "done") ? "ready" : "blocked";
}
const MIN_K = 0.3;
const MAX_K = 2.5;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

const WT_ACTIVE = ["running", "committing", "merging", "resolving"];
/** elapsed ms → "m:ss" (or "h:mm:ss" past an hour) */
const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
};

const STATE_LABEL: Record<StepState, string> = {
  done: "완료",
  running: "실행 중",
  ready: "대기",
  blocked: "선행 대기",
};

export default function PlanView({
  project,
  plan,
  taskStatus,
  statuses,
  terminals,
  planning,
  onRequestPlan,
  notes,
  onAddNote,
  onEditNote,
  onRemoveNote,
  onPlanFromNotes,
  notesUi,
  onSetNotesUi,
  onRunSteps,
  onToggleCollapse,
  onRemovePlan,
  onAddTheme,
  onAddFeature,
  onAddStep,
  onRenameNode,
  onEditStep,
  onRemoveNode,
  onSetStepDeps,
  onSetStepFeature,
  wtRun,
  wtLastRun,
  wtMsg,
  wtFix,
  onResolveFinalize,
  onStopWtRun,
  onStopBoardRun,
  onClearWtLastRun,
  onClearWtMsg,
  cardScale,
  onSetCardScale,
  board,
  savedView,
  onSetView,
  focusIds,
  onSetFocus,
  dir,
  sort,
  onSetDir,
  onSetSort,
  onJumpToStep,
  onClose,
}: {
  project: Project;
  plan: Plan | undefined;
  taskStatus: Record<string, TaskStatus>;
  statuses: Record<string, TermStatus>;
  terminals: Terminal[];
  planning: boolean;
  board?: QueueBoard;
  savedView?: PlanViewport;
  onSetView: (v: PlanViewport) => void;
  /** focused 대블럭/중블럭 ids ([] = 전체 보기) */
  focusIds: string[];
  onSetFocus: (ids: string[]) => void;
  dir: PlanDir;
  sort: PlanSort;
  onSetDir: (dir: PlanDir) => void;
  onSetSort: (sort: PlanSort) => void;
  onJumpToStep: (termId: string) => void;
  wtRun?: WtRun;
  wtLastRun?: WtRun;
  wtMsg?: string;
  wtFix?: WtFix;
  onResolveFinalize: () => void;
  onStopWtRun: () => void;
  onStopBoardRun: () => void;
  onClearWtLastRun: () => void;
  onClearWtMsg: () => void;
  cardScale: number;
  onSetCardScale: (scale: number) => void;
  onRequestPlan: (goal: string) => void;
  notes: Note[];
  onAddNote: (text: string) => void;
  onEditNote: (id: string, text: string) => void;
  onRemoveNote: (id: string) => void;
  onPlanFromNotes: (ids: string[]) => void;
  notesUi: { open: boolean; width: number };
  onSetNotesUi: (ui: { open: boolean; width: number }) => void;
  onRunSteps: (stepIds: string[], target: RunTarget) => void;
  onToggleCollapse: (nodeId: string, current: boolean) => void;
  onRemovePlan: () => void;
  onAddTheme: () => void;
  onAddFeature: (themeId: string) => void;
  onAddStep: (featureId: string) => void;
  onRenameNode: (id: string, title: string) => void;
  onEditStep: (id: string, patch: { title?: string; prompt?: string }) => void;
  onRemoveNode: (id: string) => void;
  onSetStepDeps: (stepId: string, deps: string[]) => void;
  onSetStepFeature: (stepId: string, featureId: string) => void;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [goalOpen, setGoalOpen] = useState(false); // header "＋ AI로 추가" popover
  // right memo sidebar: collapsible + width-resizable, persisted in config.
  const [notesOpen, setNotesOpen] = useState(notesUi.open);
  const [notesW, setNotesW] = useState(notesUi.width);
  const notesWRef = useRef(notesW);
  notesWRef.current = notesW;
  // persist sidebar prefs (debounced) so they survive reopen
  useEffect(() => {
    const t = window.setTimeout(() => onSetNotesUi({ open: notesOpen, width: notesW }), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesOpen, notesW]);
  // drag the sidebar's left edge to resize (drag left = wider)
  const startNotesResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const sw = notesWRef.current;
    const move = (ev: MouseEvent) =>
      setNotesW(Math.max(240, Math.min(680, sw - (ev.clientX - sx))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [runOpen, setRunOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // inline title rename
  const [stepEdit, setStepEdit] = useState<PlanStep | null>(null); // step editor modal
  const [gitRepo, setGitRepo] = useState<boolean | null>(null); // is the project a git repo?
  const [tocOpen, setTocOpen] = useState<Record<string, boolean>>({}); // outline: 대블럭 expanded?
  const toggleTocOpen = (id: string) => setTocOpen((m) => ({ ...m, [id]: !(m[id] ?? true) }));

  // focusIds is a fresh array each render (App spreads it); derive a stable key
  // for effect/memo deps and a Set for membership checks.
  const focusKey = focusIds.slice().sort().join("|");
  const focusSet = useMemo(() => new Set(focusIds), [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // TOC click: plain click focuses just this block (clicking the sole-focused one
  // clears back to 전체); Ctrl/⌘/Shift-click adds/removes it from the selection.
  const pickFocus = (id: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey)
      onSetFocus(focusSet.has(id) ? focusIds.filter((x) => x !== id) : [...focusIds, id]);
    else onSetFocus(focusSet.has(id) && focusIds.length === 1 ? [] : [id]);
  };

  // --- canvas viewport (pan + zoom) ---
  // The whole graph is transformed by translate(x,y)·scale(k); the auto-layout is
  // untouched, we just move/scale the "world" inside the clipping canvas.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<PlanViewport>(savedView ?? { x: 24, y: 24, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const spaceHeld = useRef(false); // Space → left-drag pans (even over nodes)
  // --- camera easing: programmatic view changes (fit / zoom buttons / focus
  // switch) glide; interactive pan/wheel are instant (cancel the glide). ---
  const [vAnim, setVAnim] = useState(false);
  const vAnimRef = useRef(false);
  const animTimer = useRef<number | undefined>(undefined);
  const setAnim = (on: boolean) => {
    vAnimRef.current = on;
    setVAnim(on);
  };
  const animateView = () => {
    setAnim(true);
    window.clearTimeout(animTimer.current);
    animTimer.current = window.setTimeout(() => setAnim(false), 460);
  };
  const cancelAnim = () => {
    if (!vAnimRef.current) return;
    window.clearTimeout(animTimer.current);
    setAnim(false);
  };
  // --- manual dependency linking: drag from a step's handle onto another step ---
  const [link, setLink] = useState<{ from: string; x: number; y: number } | null>(null);
  const linkRef = useRef(link);
  linkRef.current = link;
  const suppressClick = useRef(false); // skip the click that ends a link/marquee gesture
  // --- marquee box-select: left-drag on empty canvas selects steps inside ---
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef(marquee);
  marqueeRef.current = marquee;
  const layoutRef = useRef<ReturnType<typeof layoutPlan> | null>(null);
  // --- drag-to-reparent: drag a step's header onto a feature (or sibling step) ---
  const [drag, setDrag] = useState<{ stepId: string; x: number; y: number } | null>(null); // ghost pos (world)
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const dragArm = useRef<{ stepId: string; sx: number; sy: number } | null>(null); // pre-threshold
  const [dropFeat, setDropFeat] = useState<string | null>(null); // feature id under cursor
  const stepByIdRef = useRef<Record<string, PlanStep>>({});
  const reparentRef = useRef(onSetStepFeature); // avoid stale closure in window handlers
  reparentRef.current = onSetStepFeature;
  // --- per-step elapsed time: when a step's session started working ---
  const startAt = useRef<Record<string, number>>({});
  const [nowTs, setNowTs] = useState(0);

  // screen → world coords inside the transformed graph
  const toWorld = (clientX: number, clientY: number) => {
    const r = canvasRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - (r?.left ?? 0) - v.x) / v.k,
      y: (clientY - (r?.top ?? 0) - v.y) / v.k,
    };
  };

  // persist viewport (debounced) so pan/zoom survives reopen — never per-frame
  useEffect(() => {
    const t = window.setTimeout(() => onSetView(view), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // the feature a screen point would drop a step into (feature node, or a sibling
  // step's feature); excludes the dragged step itself
  const dropFeatureAt = (clientX: number, clientY: number, exceptStep: string): string | null => {
    const w = toWorld(clientX, clientY);
    const hit = (layoutRef.current?.nodes ?? []).find(
      (n) =>
        (n.kind === "feature" || n.kind === "step") &&
        n.id !== exceptStep &&
        w.x >= n.x &&
        w.x <= n.x + n.w &&
        w.y >= n.y &&
        w.y <= n.y + n.h,
    );
    if (!hit) return null;
    return hit.kind === "feature" ? hit.id : stepByIdRef.current[hit.id]?.featureId ?? null;
  };

  // pan + link line + marquee + drag-to-reparent, driven by window mouse events
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (panRef.current) {
        const p = panRef.current;
        setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
        return;
      }
      if (linkRef.current) {
        const w = toWorld(e.clientX, e.clientY);
        setLink((l) => (l ? { ...l, x: w.x, y: w.y } : l));
        return;
      }
      if (marqueeRef.current) {
        const w = toWorld(e.clientX, e.clientY);
        setMarquee((m) => (m ? { ...m, x1: w.x, y1: w.y } : m));
        return;
      }
      // arm → drag once past a small threshold, then track ghost + drop target
      const arm = dragArm.current;
      if (arm && !dragRef.current) {
        if (Math.abs(e.clientX - arm.sx) + Math.abs(e.clientY - arm.sy) > 5) {
          const w = toWorld(e.clientX, e.clientY);
          setDrag({ stepId: arm.stepId, x: w.x, y: w.y });
        }
      }
      if (dragRef.current) {
        const w = toWorld(e.clientX, e.clientY);
        const sid = dragRef.current.stepId;
        setDrag((d) => (d ? { ...d, x: w.x, y: w.y } : d));
        const feat = dropFeatureAt(e.clientX, e.clientY, sid);
        const cur = stepByIdRef.current[sid]?.featureId;
        setDropFeat(feat && feat !== cur ? feat : null);
      }
    };
    const up = (e: MouseEvent) => {
      if (panRef.current) {
        panRef.current = null;
        setPanning(false);
      }
      if (linkRef.current) setLink(null); // released on empty space → cancel
      const mq = marqueeRef.current;
      if (mq) {
        // select every step whose card intersects the box
        const lo = { x: Math.min(mq.x0, mq.x1), y: Math.min(mq.y0, mq.y1) };
        const hi = { x: Math.max(mq.x0, mq.x1), y: Math.max(mq.y0, mq.y1) };
        const hit = (layoutRef.current?.nodes ?? [])
          .filter((n) => n.kind === "step")
          .filter((n) => n.x < hi.x && n.x + n.w > lo.x && n.y < hi.y && n.y + n.h > lo.y)
          .map((n) => n.id);
        if (hit.length || !e.shiftKey)
          setSel((s) => (e.shiftKey ? new Set([...s, ...hit]) : new Set(hit)));
        suppressClick.current = true;
        setMarquee(null);
      }
      const d = dragRef.current;
      if (d) {
        const feat = dropFeatureAt(e.clientX, e.clientY, d.stepId);
        const cur = stepByIdRef.current[d.stepId]?.featureId;
        if (feat && feat !== cur) reparentRef.current(d.stepId, feat);
        suppressClick.current = true;
        setDrag(null);
        setDropFeat(null);
      }
      dragArm.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Space toggles pan-drag mode (tracked globally so it works while over nodes)
  useEffect(() => {
    const isTyping = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    const down = (e: KeyboardEvent) => {
      if (e.key === " " && !isTyping(e.target)) {
        spaceHeld.current = true;
        e.preventDefault();
      } else if (e.key === "Escape") {
        if (linkRef.current) setLink(null);
        else if (marqueeRef.current) setMarquee(null);
        else if (!isTyping(e.target)) onClose();
      } else if ((e.key === "f" || e.key === "F") && !isTyping(e.target)) {
        fitView();
      } else if (e.key === "0" && !isTyping(e.target)) {
        animateView();
        setView((v) => ({ ...v, k: 1 }));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") spaceHeld.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // wheel zoom toward the cursor (native listener so preventDefault isn't passive-blocked)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // let a scrollable instruction textarea scroll instead of zooming
      const ta = (e.target as HTMLElement).closest?.(".plan-node-prompt") as HTMLTextAreaElement | null;
      if (ta && ta.scrollHeight > ta.clientHeight) return;
      e.preventDefault();
      cancelAnim(); // wheel zoom is instant, not glided
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
    cancelAnim(); // dragging is instant, not glided
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
    setPanning(true);
  };

  // capture phase: Space+left starts a pan before nodes/textarea see the event
  const onCanvasMouseDownCapture = (e: React.MouseEvent) => {
    if (spaceHeld.current && e.button === 0) {
      startPan(e);
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (panRef.current) return; // already handled in capture (Space+left)
    const t = e.target as HTMLElement;
    const onBg =
      t === canvasRef.current ||
      t.classList.contains("plan-viewport") ||
      t.classList.contains("plan-graph");
    if (e.button === 2 || e.button === 1) {
      startPan(e); // right / middle drag → pan
      e.preventDefault();
    } else if (e.button === 0 && onBg) {
      const w = toWorld(e.clientX, e.clientY); // left drag on empty canvas → marquee
      setMarquee({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
      e.preventDefault();
    }
  };

  // zoom around the canvas center (button controls) — glided
  const zoomBy = (factor: number) => {
    animateView();
    setView((v) => {
      const r = canvasRef.current?.getBoundingClientRect();
      const px = (r?.width ?? 0) / 2;
      const py = (r?.height ?? 0) / 2;
      const k = clampK(v.k * factor);
      const wx = (px - v.x) / v.k;
      const wy = (py - v.y) / v.k;
      return { k, x: px - wx * k, y: py - wy * k };
    });
  };

  useEffect(() => {
    let alive = true;
    gitIsRepo(project.path)
      .then((r) => alive && setGitRepo(r))
      .catch(() => alive && setGitRepo(false));
    return () => {
      alive = false;
    };
  }, [project.path]);

  // step ids grouped under each feature / theme (for progress + group-select)
  const { stepIdsUnderFeature, stepIdsUnderTheme } = useMemo(() => {
    const sbf: Record<string, PlanStep[]> = {};
    for (const s of plan?.steps ?? []) (sbf[s.featureId] ??= []).push(s);
    const underFeat: Record<string, string[]> = {};
    for (const [fid, steps] of Object.entries(sbf)) underFeat[fid] = steps.map((s) => s.id);
    const underTheme: Record<string, string[]> = {};
    for (const f of plan?.features ?? [])
      (underTheme[f.themeId] ??= []).push(...(underFeat[f.id] ?? []));
    return { stepIdsUnderFeature: underFeat, stepIdsUnderTheme: underTheme };
  }, [plan]);

  // Effective status: live task status, plus steps persisted as completed in the
  // plan (so done-state survives restarts and accumulates in the graph).
  const effTs = useMemo(() => {
    const m: Record<string, TaskStatus> = { ...taskStatus };
    for (const id of Object.keys(plan?.completed ?? {})) m[id] = "done";
    return m;
  }, [taskStatus, plan]);

  const doneOf = (ids: string[]) => ids.filter((id) => effTs[id] === "done").length;

  // effective collapse: explicit state, else auto-collapse when that node's steps are all done
  const isCollapsed = (nodeId: string, ids: string[]) => {
    const explicit = plan?.collapsed?.[nodeId];
    if (explicit !== undefined) return explicit;
    return ids.length > 0 && doneOf(ids) === ids.length;
  };

  const layout = useMemo(() => {
    if (!plan) return null;
    return layoutPlan(
      plan,
      (id) => {
        const ids = stepIdsUnderTheme[id] ?? stepIdsUnderFeature[id] ?? [];
        return isCollapsed(id, ids);
      },
      cardScale,
      dir,
      sort,
      focusIds,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, effTs, stepIdsUnderTheme, stepIdsUnderFeature, cardScale, dir, sort, focusKey]);

  layoutRef.current = layout; // marquee hit-test reads the latest node geometry

  // fit the graph into the canvas, centered. Fit to the actual node bounding box
  // (not layout.width/height — those reserve empty bow-padding on the deps' side,
  // which would push the content off-center), then center that box in the canvas.
  const fitView = () => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r || !layout || layout.nodes.length === 0) return;
    const pad = 56;
    const minX = Math.min(...layout.nodes.map((n) => n.x));
    const minY = Math.min(...layout.nodes.map((n) => n.y));
    const maxX = Math.max(...layout.nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...layout.nodes.map((n) => n.y + n.h));
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const k = clampK(Math.min((r.width - pad) / w, (r.height - pad) / h));
    animateView();
    setView({ k, x: (r.width - w * k) / 2 - minX * k, y: (r.height - h * k) / 2 - minY * k });
  };

  // re-fit when the flow direction changes (the old pan/zoom no longer matches);
  // skip the first run so a saved viewport is respected on open
  const dirInit = useRef(true);
  useEffect(() => {
    if (dirInit.current) {
      dirInit.current = false;
      return;
    }
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  // re-fit when the focused blocks change (the filtered graph is a new shape);
  // skip the first run so a saved viewport is respected on open
  const focusInit = useRef(true);
  useEffect(() => {
    if (focusInit.current) {
      focusInit.current = false;
      return;
    }
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const total = plan?.steps.length ?? 0;
  const done = (plan?.steps ?? []).filter((s) => effTs[s.id] === "done").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const hasGraph = !!plan && (plan.themes.length > 0 || plan.steps.length > 0);

  const toggleStep = (id: string) =>
    setSel((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleGroup = (ids: string[]) =>
    setSel((s) => {
      const next = new Set(s);
      const allOn = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) (allOn ? next.delete(id) : next.add(id));
      return next;
    });

  const stepById = useMemo(
    () => Object.fromEntries((plan?.steps ?? []).map((s) => [s.id, s])),
    [plan],
  );

  // 대블럭별 중블럭 묶음 — 왼쪽 목차(아웃라인)용
  const featuresByTheme = useMemo(() => {
    const m: Record<string, PlanFeature[]> = {};
    for (const fe of plan?.features ?? []) (m[fe.themeId] ??= []).push(fe);
    return m;
  }, [plan]);
  stepByIdRef.current = stepById; // for drop-target resolution inside window handlers
  const wtByStep = useMemo(() => {
    const m: Record<string, WtStep> = {};
    for (const s of wtRun?.steps ?? []) m[s.stepId] = s;
    return m;
  }, [wtRun]);

  // stepId → the live terminal running it (worktree step, or a board lane task)
  const stepTerm = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of wtRun?.steps ?? []) {
      const term = s.resolveTermId ?? s.termId;
      if (term) m[s.stepId] = term;
    }
    if (board) {
      const laneById = new Map(board.lanes.map((l) => [l.id, l]));
      for (const t of board.tasks) {
        const lane = laneById.get(t.laneId);
        const term = lane && laneLiveTerm(lane);
        if (term) m[t.id] = term;
      }
    }
    return m;
  }, [wtRun, board]);

  // [2순위] critical path (longest dependency chain) — toggled on demand
  const [showCrit, setShowCrit] = useState(false);
  const crit = useMemo(() => (plan ? criticalPath(plan) : null), [plan]);
  // steps runnable right now: not done/running and every dep already done
  const readyIds = useMemo(
    () => (plan?.steps ?? []).filter((s) => stepState(s, effTs) === "ready").map((s) => s.id),
    [plan, effTs],
  );

  // [1순위] track when each step's session started working, for an elapsed clock
  useEffect(() => {
    const active = new Set<string>();
    for (const s of plan?.steps ?? []) {
      const wt = wtByStep[s.id];
      const isActive = wt ? WT_ACTIVE.includes(wt.phase) : stepState(s, effTs) === "running";
      if (isActive) active.add(s.id);
    }
    const t = startAt.current;
    for (const id of active) if (!(id in t)) t[id] = Date.now();
    for (const id of Object.keys(t)) if (!active.has(id)) delete t[id];
  }, [plan, effTs, wtByStep]);

  // 1s tick so the elapsed clocks advance while the plan is open
  useEffect(() => {
    if (!hasGraph) return;
    const id = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasGraph]);

  // inline rename input shared by theme/feature nodes
  const renameInput = (id: string, title: string) => (
    <input
      className="plan-node-edit"
      autoFocus
      defaultValue={title}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        onRenameNode(id, e.target.value.trim() || title);
        setEditingId(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditingId(null);
      }}
    />
  );

  return (
    <div className="plan-overlay" onMouseDown={onClose}>
      <div className="plan" onMouseDown={(e) => e.stopPropagation()}>
        <header className="plan-head">
          <strong>{project.name}</strong>
          <span className="plan-head-tag">플랜 그래프</span>
          {hasGraph && total > 0 && (
            <div className="plan-progress">
              <div className="plan-bar">
                <div className="plan-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="plan-pct">
                {done}/{total} · {pct}%
              </span>
            </div>
          )}
          <div className="plan-head-actions">
            <div className="plan-cardsize" title="카드 크기 (저장됨)">
              <button
                className="icon-btn"
                onClick={() => onSetCardScale(Math.max(0.8, Math.round((cardScale - 0.1) * 10) / 10))}
                disabled={cardScale <= 0.8}
                title="작게"
              >
                －
              </button>
              <span className="plan-cardsize-val">{Math.round(cardScale * 100)}%</span>
              <button
                className="icon-btn"
                onClick={() => onSetCardScale(Math.min(2, Math.round((cardScale + 0.1) * 10) / 10))}
                disabled={cardScale >= 2}
                title="크게"
              >
                ＋
              </button>
            </div>
            <LayoutMenu dir={dir} sort={sort} onSetDir={onSetDir} onSetSort={onSetSort} />
            {hasGraph && (crit?.length ?? 0) > 1 && (
              <button
                className={`btn ${showCrit ? "primary" : ""}`}
                onClick={() => setShowCrit((v) => !v)}
                title="가장 긴 선행 사슬(병목)을 초록색으로 강조 — 이 사슬 길이가 플랜의 최소 단계 수를 정해요"
              >
                ⟂ 병목경로{showCrit ? ` · ${crit?.length}` : ""}
              </button>
            )}
            {/* AI 요청 추가 — 헤더 버튼을 눌러 입력 팝오버를 연다 (세로 공간 절약) */}
            <div className="plan-goalmenu" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className="btn primary"
                onClick={() => setGoalOpen((o) => !o)}
                disabled={planning}
                title="요청을 입력하면 대블럭 → 중블럭 → 소블럭으로 분해해 그래프에 더해요"
              >
                {planning ? "구성 중…" : "＋ AI로 추가"}
              </button>
              {goalOpen && !planning && (
                <>
                  <div className="plan-menu-backdrop" onClick={() => setGoalOpen(false)} />
                  <div className="plan-menu plan-goalpop">
                    <div className="plan-menu-label">AI로 요청 추가</div>
                    <textarea
                      className="plan-goalpop-in"
                      autoFocus
                      placeholder="요청을 입력하면 대블럭 → 중블럭 → 소블럭으로 분해해 그래프에 더해요  (예: UI 개선 — 다크모드)"
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && goal.trim()) {
                          e.preventDefault();
                          onRequestPlan(goal.trim());
                          setGoal("");
                          setGoalOpen(false);
                        }
                      }}
                    />
                    <div className="plan-goalpop-actions">
                      <span className="plan-goalpop-hint">Enter 추가 · Shift+Enter 줄바꿈</span>
                      <button
                        className="btn primary"
                        disabled={!goal.trim()}
                        onClick={() => {
                          onRequestPlan(goal.trim());
                          setGoal("");
                          setGoalOpen(false);
                        }}
                      >
                        요청 추가
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <button className="btn" onClick={onAddTheme} title="대블럭을 직접 추가">
              ＋ 대블럭
            </button>
            <button className="icon-btn" onClick={onClose} title="닫기">
              ✕
            </button>
          </div>
        </header>

        <>

        {planning && (
          <div className="plan-note">
            플래너 세션이 <code>.fleet/plan.json</code>을 작성하는 중… 완료되면 그래프에 자동 반영돼요.
          </div>
        )}
        {wtFix ? (
          <div className="plan-note plan-note-warn plan-note-fix">
            <span>⚠ {wtMsg || `${wtFix.branch} 최종 병합에 손이 필요해요.`}</span>
            <button className="plan-fix-btn" onClick={onResolveFinalize}>
              🤖 클로드한테 해결시키기
            </button>
          </div>
        ) : wtMsg ? (
          <div className="plan-note plan-note-warn" onClick={onClearWtMsg} title="클릭해 닫기">
            ⚠ {wtMsg}
          </div>
        ) : null}

        {/* Worktree run — live banner + activity log, or the last finished run */}
        {(wtRun ?? wtLastRun) && (
          <WtLogPanel
            run={(wtRun ?? wtLastRun)!}
            live={!!wtRun}
            onStop={onStopWtRun}
            onDismiss={onClearWtLastRun}
          />
        )}

        {/* Non-worktree run — steps dispatched onto live terminals. Offer a stop. */}
        {!wtRun && board?.running && (
          <div className="plan-runbar">
            <span className="plan-runbar-dot" />
            <span className="plan-runbar-text">
              실행 중 · {board.tasks.filter((t) => taskStatus[t.id] === "done").length}/
              {board.tasks.length} 완료
            </span>
            <button className="plan-runbar-stop" onClick={onStopBoardRun}>
              중단
            </button>
          </div>
        )}

        {/* Body: outline (목차) + graph canvas + memo sidebar (right) */}
        <div className="plan-body">
          {hasGraph && (plan?.themes.length ?? 0) > 0 && (
            <aside className="plan-toc" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className={`plan-toc-all ${focusIds.length === 0 ? "on" : ""}`}
                onClick={() => onSetFocus([])}
                title="모든 대블럭을 한 화면에 보기 · Ctrl/⌘+클릭으로 여러 블럭 선택"
              >
                <span className="plan-toc-label">전체 보기</span>
                {total > 0 && (
                  <span className="plan-toc-count">
                    {done}/{total}
                  </span>
                )}
              </button>
              <div className="plan-toc-list">
                {(plan?.themes ?? []).map((t) => {
                  const tIds = stepIdsUnderTheme[t.id] ?? [];
                  const feats = featuresByTheme[t.id] ?? [];
                  const expanded = tocOpen[t.id] ?? true;
                  const allDone = tIds.length > 0 && doneOf(tIds) === tIds.length;
                  return (
                    <div className="plan-toc-grp" key={t.id}>
                      <div className={`plan-toc-row theme ${focusSet.has(t.id) ? "on" : ""}`}>
                        <button
                          className="plan-toc-caret"
                          disabled={feats.length === 0}
                          onClick={() => toggleTocOpen(t.id)}
                          title={expanded ? "접기" : "펼치기"}
                        >
                          {feats.length === 0 ? "" : expanded ? "▾" : "▸"}
                        </button>
                        <button
                          className="plan-toc-label"
                          onClick={(e) => pickFocus(t.id, e)}
                          title={`${t.title} — 클릭: 이 대블럭만 · Ctrl/⌘+클릭: 여러 개`}
                        >
                          {t.title}
                        </button>
                        <span className={`plan-toc-count ${allDone ? "done" : ""}`}>
                          {allDone ? "✓ " : ""}
                          {doneOf(tIds)}/{tIds.length}
                        </span>
                      </div>
                      {expanded &&
                        feats.map((fe) => {
                          const fIds = stepIdsUnderFeature[fe.id] ?? [];
                          const fDone = fIds.length > 0 && doneOf(fIds) === fIds.length;
                          return (
                            <button
                              key={fe.id}
                              className={`plan-toc-row feature ${focusSet.has(fe.id) ? "on" : ""}`}
                              onClick={(e) => pickFocus(fe.id, e)}
                              title={`${fe.title} — 클릭: 이 중블럭만 · Ctrl/⌘+클릭: 여러 개`}
                            >
                              <span className="plan-toc-label">{fe.title}</span>
                              <span className={`plan-toc-count ${fDone ? "done" : ""}`}>
                                {doneOf(fIds)}/{fIds.length}
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  );
                })}
              </div>
            </aside>
          )}

        {/* Graph canvas */}
        <div
          className={`plan-canvas ${panning ? "panning" : ""} ${link ? "linking" : ""} ${
            marquee ? "marqueeing" : ""
          }`}
          ref={canvasRef}
          onMouseDownCapture={onCanvasMouseDownCapture}
          onMouseDown={onCanvasMouseDown}
          onContextMenu={(e) => e.preventDefault()}
        >
          {!hasGraph || !layout ? (
            <div className="plan-empty">
              아직 플랜이 없어요. 오른쪽 위 <b>＋ AI로 추가</b>에 요청을 입력하면 대블럭 → 중블럭 → 소블럭
              그래프로 쌓이고,
              <br />
              이어지는 요청도 같은 그래프에 붙어요. 직접 만들려면 <b>＋ 대블럭</b>으로 시작하세요.
            </div>
          ) : (
            <div
              className={`plan-viewport ${vAnim && !panning ? "anim" : ""}`}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
            >
            <div
              key={focusKey}
              className="plan-graph"
              style={
                { width: layout.width, height: layout.height, "--pcs": cardScale } as CSSProperties
              }
            >
              <svg className="plan-edges" width={layout.width} height={layout.height}>
                <defs>
                  <marker
                    id="plan-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L8,4 L0,8 z" className="plan-arrow-fill" />
                  </marker>
                </defs>
                {layout.edges.map((e) =>
                  e.kind === "dep" ? (
                    // dep arc + a fat transparent hit-path so it can be clicked to remove
                    <g key={e.id} className="plan-edge-dep-g">
                      <path
                        d={e.d}
                        className={`plan-edge dep ${
                          showCrit && crit?.edges.has(`${e.from}->${e.to}`) ? "crit" : ""
                        }`}
                        markerEnd="url(#plan-arrow)"
                      />
                      <path
                        d={e.d}
                        className="plan-edge-hit"
                        onClick={() =>
                          e.to &&
                          e.from &&
                          onSetStepDeps(e.to, (stepById[e.to]?.deps ?? []).filter((d) => d !== e.from))
                        }
                      >
                        <title>클릭: 선행 연결 제거</title>
                      </path>
                    </g>
                  ) : (
                    <path key={e.id} d={e.d} className="plan-edge hier" />
                  ),
                )}
                {/* live link being dragged from a step's handle */}
                {link &&
                  (() => {
                    const src = layout.nodes.find((n) => n.id === link.from);
                    if (!src) return null;
                    return (
                      <path
                        className="plan-edge dep linking"
                        markerEnd="url(#plan-arrow)"
                        d={`M${src.x + src.w},${src.y + src.h / 2} L${link.x},${link.y}`}
                      />
                    );
                  })()}
                {/* marquee box-select rectangle */}
                {marquee && (
                  <rect
                    className="plan-marquee"
                    x={Math.min(marquee.x0, marquee.x1)}
                    y={Math.min(marquee.y0, marquee.y1)}
                    width={Math.abs(marquee.x1 - marquee.x0)}
                    height={Math.abs(marquee.y1 - marquee.y0)}
                  />
                )}
              </svg>

              {layout.nodes.map((n) => {
                if (n.kind === "step") {
                  const s = stepById[n.id];
                  if (!s) return null;
                  const st = stepState(s, effTs);
                  const wt = wtByStep[n.id];
                  const liveTerm = wt?.resolveTermId ?? wt?.termId ?? stepTerm[n.id];
                  const liveTs = liveTerm ? statuses[liveTerm] : undefined;
                  // base visual: worktree phase → board-run live status → plan state
                  let cls: string;
                  let label: string;
                  if (wt) {
                    cls = `wt-${wt.phase}`;
                    label = PHASE_LABEL[wt.phase];
                  } else if (st === "running") {
                    cls = liveTs === "waiting" ? "waiting" : "running";
                    label = liveTs === "waiting" ? "승인 필요" : "실행 중";
                  } else {
                    cls = st;
                    label = STATE_LABEL[st];
                  }
                  const onCrit = showCrit && !!crit?.nodes.has(n.id);
                  const isReady = st === "ready";
                  const on = sel.has(n.id);
                  const dragging = drag?.stepId === n.id;
                  const startedAt = startAt.current[n.id];
                  const elapsed = startedAt ? fmtElapsed(nowTs - startedAt) : null;
                  // When running in a worktree, surface its branch + dir so the
                  // user can see exactly which worktree this step is using.
                  const tip = wt
                    ? [wt.note, `브랜치: ${wt.branch}`, `워크트리: ${wt.dir}`]
                        .filter(Boolean)
                        .join("\n")
                    : s.prompt || "(prompt 비어있음 — 더블클릭해 작성)";
                  return (
                    <div
                      key={n.id}
                      className={`plan-node step ${cls} ${on ? "sel" : ""} ${
                        isReady ? "is-ready" : ""
                      } ${onCrit ? "crit" : ""} ${dragging ? "dragging" : ""}`}
                      style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        toggleStep(n.id);
                      }}
                      onMouseUp={() => {
                        const l = linkRef.current;
                        if (l && l.from !== n.id) {
                          const cur = stepById[n.id]?.deps ?? [];
                          if (!cur.includes(l.from)) onSetStepDeps(n.id, [...cur, l.from]);
                          suppressClick.current = true;
                          setLink(null);
                        }
                      }}
                      onDoubleClick={() => setStepEdit(s)}
                    >
                      <div
                        className="plan-node-step-head"
                        title="드래그해서 다른 중블럭으로 이동"
                        onMouseDown={(e) => {
                          if (e.button !== 0 || spaceHeld.current) return; // left only; Space = pan
                          e.preventDefault(); // stop native text-selection drag
                          dragArm.current = { stepId: n.id, sx: e.clientX, sy: e.clientY };
                        }}
                      >
                        <span className="plan-node-title">{n.title}</span>
                        {elapsed && (st === "running" || wt) && (
                          <span className="plan-node-elapsed">{elapsed}</span>
                        )}
                        <span className={`plan-node-state ${cls}`}>{label}</span>
                      </div>
                      {/* instruction (지시문) — edit inline; while a worktree run
                          is active show its read-only status instead */}
                      {wt ? (
                        <div className="plan-node-body" title={tip}>
                          {tip}
                        </div>
                      ) : (
                        <textarea
                          key={s.id}
                          className="plan-node-prompt"
                          defaultValue={s.prompt}
                          placeholder="지시문 입력…"
                          spellCheck={false}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            if (e.target.value !== s.prompt) onEditStep(s.id, { prompt: e.target.value });
                          }}
                        />
                      )}
                      {/* drag this handle onto another step to make it a prerequisite */}
                      <span
                        className="plan-link-handle"
                        title="드래그해서 다른 소블럭에 '선행'으로 연결"
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          const w = toWorld(e.clientX, e.clientY);
                          setLink({ from: n.id, x: w.x, y: w.y });
                        }}
                      />
                      <span className="plan-node-actions">
                        {liveTerm && (
                          <button
                            className="plan-node-act"
                            title="이 소블럭 세션으로 이동"
                            onClick={(e) => {
                              e.stopPropagation();
                              onJumpToStep(liveTerm);
                            }}
                          >
                            👁
                          </button>
                        )}
                        <button
                          className="plan-node-act"
                          title="편집"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStepEdit(s);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="plan-node-act del"
                          title="삭제"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveNode(n.id);
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  );
                }
                // theme / feature node
                const ids = n.kind === "theme" ? stepIdsUnderTheme[n.id] ?? [] : stepIdsUnderFeature[n.id] ?? [];
                const collapsed = isCollapsed(n.id, ids);
                const d = doneOf(ids);
                const allDone = ids.length > 0 && d === ids.length;
                const allSel = ids.length > 0 && ids.every((id) => sel.has(id));
                return (
                  <div
                    key={n.id}
                    className={`plan-node ${n.kind} ${allDone ? "done" : ""} ${allSel ? "sel" : ""} ${
                      dropFeat === n.id ? "drop-ok" : ""
                    }`}
                    style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                  >
                    <button
                      className="plan-node-caret"
                      title={collapsed ? "펼치기" : "접기"}
                      onClick={() => onToggleCollapse(n.id, collapsed)}
                    >
                      {collapsed ? "▸" : "▾"}
                    </button>
                    {editingId === n.id ? (
                      renameInput(n.id, n.title)
                    ) : (
                      <span
                        className="plan-node-title"
                        onClick={() => setEditingId(n.id)}
                        title={`${n.title} — 클릭: 이름 변경`}
                      >
                        {n.title}
                      </span>
                    )}
                    <span
                      className="plan-node-count clickable"
                      onClick={() => toggleGroup(ids)}
                      title="클릭: 하위 소블럭 전체 선택/해제"
                    >
                      {allDone ? "✓ " : ""}
                      {d}/{ids.length}
                    </span>
                    <span className="plan-node-actions">
                      <button
                        className="plan-node-act"
                        title={n.kind === "theme" ? "중블럭 추가" : "소블럭 추가"}
                        onClick={(e) => {
                          e.stopPropagation();
                          n.kind === "theme" ? onAddFeature(n.id) : onAddStep(n.id);
                        }}
                      >
                        ＋
                      </button>
                      <button
                        className="plan-node-act del"
                        title="삭제"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveNode(n.id);
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                );
              })}

              {/* drag-to-reparent ghost following the cursor (world coords) */}
              {drag && (
                <div className="plan-drag-ghost" style={{ left: drag.x + 10, top: drag.y + 8 }}>
                  {stepById[drag.stepId]?.title ?? "소블럭"}
                  <span className="plan-drag-ghost-hint">
                    {dropFeat ? "여기 중블럭으로 이동" : "중블럭 위에 놓기"}
                  </span>
                </div>
              )}
            </div>
            </div>
          )}

          {/* canvas interactions, tucked into a ? so they don't cover the graph */}
          {hasGraph && layout && (
            <div className="plan-help" tabIndex={0} onMouseDown={(e) => e.stopPropagation()}>
              ?
              <div className="plan-tip">
                <div className="plan-tip-title">캔버스 조작</div>
                <div className="plan-tip-row hot">
                  <span className="plan-kbd">우클릭</span>
                  <span className="plan-kbd">Space</span>
                  <span>드래그 — 화면 이동</span>
                </div>
                <div className="plan-tip-row hot">
                  <span className="plan-kbd">휠</span>
                  <span>확대 / 축소</span>
                  <span className="plan-kbd">F</span>
                  <span>화면 맞춤</span>
                </div>
                <div className="plan-tip-row">
                  빈 곳 <b>드래그</b>로 박스 선택
                </div>
                <div className="plan-tip-row">
                  소블럭 우측 점을 끌어 <b>선행 연결</b>
                </div>
                <div className="plan-tip-row">
                  연결 점선 <b>클릭</b>으로 해제
                </div>
              </div>
            </div>
          )}

          {/* Zoom / fit controls (floating, bottom-right) */}
          {hasGraph && layout && (
            <div className="plan-zoom" onMouseDown={(e) => e.stopPropagation()}>
              <button className="plan-zoom-btn" title="축소" onClick={() => zoomBy(1 / 1.2)}>
                －
              </button>
              <button
                className="plan-zoom-val"
                title="100%로"
                onClick={() => setView((v) => ({ ...v, k: 1 }))}
              >
                {Math.round(view.k * 100)}%
              </button>
              <button className="plan-zoom-btn" title="확대" onClick={() => zoomBy(1.2)}>
                ＋
              </button>
              <button className="plan-zoom-btn fit" title="화면에 맞춤" onClick={fitView}>
                ⤢
              </button>
            </div>
          )}

          {/* collapsed handle: a slim tab on the graph's right edge */}
          {!notesOpen && (
            <button
              className="plan-memo-tab"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setNotesOpen(true)}
              title="메모 열기"
            >
              메모{notes.length > 0 ? ` ${notes.length}` : ""}
            </button>
          )}
        </div>

        {/* Memo sidebar (right, collapsible + width-resizable) */}
        {notesOpen && (
          <aside
            className="plan-memo"
            style={{ width: notesW }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="plan-memo-resize" onMouseDown={startNotesResize} title="드래그해서 너비 조절" />
            <div className="plan-memo-head">
              <span className="plan-memo-title">메모{notes.length > 0 ? ` ${notes.length}` : ""}</span>
              <button
                className="plan-memo-collapse"
                onClick={() => setNotesOpen(false)}
                title="사이드바 접기"
              >
                ⇥
              </button>
            </div>
            <NotesPanel
              notes={notes}
              planning={planning}
              onAdd={onAddNote}
              onEdit={onEditNote}
              onRemove={onRemoveNote}
              onPlanFromNotes={onPlanFromNotes}
            />
          </aside>
        )}
        </div>

        {/* Selection action bar */}
        {hasGraph && total > 0 && (
          <footer className="plan-foot">
            <span className="plan-selinfo">
              {sel.size}개 소블럭 선택
              {readyIds.length > 0 && <span className="plan-readytag">실행 가능 {readyIds.length}</span>}
            </span>
            <div className="plan-foot-actions">
              <button
                className="btn"
                disabled={!readyIds.length}
                onClick={() => setSel(new Set(readyIds))}
                title="선행이 모두 끝나 지금 바로 돌릴 수 있는 소블럭만 선택"
              >
                지금 실행 가능 ({readyIds.length})
              </button>
              <button
                className="btn"
                onClick={() =>
                  setSel(new Set(plan!.steps.filter((s) => effTs[s.id] !== "done").map((s) => s.id)))
                }
              >
                남은 소블럭 전체
              </button>
              <button className="btn" onClick={() => setSel(new Set())} disabled={!sel.size}>
                선택 해제
              </button>
              <button className="btn danger" onClick={onRemovePlan}>
                플랜 삭제
              </button>
              <button className="btn primary" disabled={!sel.size} onClick={() => setRunOpen(true)}>
                선택 실행 ({sel.size})
              </button>
            </div>
          </footer>
        )}
        </>
      </div>

      {runOpen && plan && (
        <RunDialog
          steps={plan.steps.filter((s) => sel.has(s.id))}
          terminals={terminals}
          statuses={statuses}
          gitRepo={gitRepo}
          onClose={() => setRunOpen(false)}
          onRun={(target) => {
            onRunSteps([...sel], target);
            setRunOpen(false);
          }}
        />
      )}

      {stepEdit && (
        <StepEditor
          step={stepEdit}
          onClose={() => setStepEdit(null)}
          onSave={(patch) => {
            onEditStep(stepEdit.id, patch);
            setStepEdit(null);
          }}
        />
      )}
    </div>
  );
}

/** Header popover to pick the graph's flow direction + sibling order (persisted). */
function LayoutMenu({
  dir,
  sort,
  onSetDir,
  onSetSort,
}: {
  dir: PlanDir;
  sort: PlanSort;
  onSetDir: (dir: PlanDir) => void;
  onSetSort: (sort: PlanSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const DIRS: { k: PlanDir; icon: string; label: string }[] = [
    { k: "LR", icon: "→", label: "가로" },
    { k: "RL", icon: "←", label: "가로(역)" },
    { k: "TB", icon: "↓", label: "세로" },
    { k: "BT", icon: "↑", label: "세로(역)" },
    { k: "H2", icon: "⇄", label: "양쪽 가로" },
    { k: "V2", icon: "⇅", label: "양쪽 세로" },
    { k: "RAD", icon: "✳", label: "방사형" },
    { k: "GRID", icon: "▦", label: "격자" },
  ];
  return (
    <div className="plan-layoutmenu" onMouseDown={(e) => e.stopPropagation()}>
      <button className="btn" onClick={() => setOpen((o) => !o)} title="레이아웃 방향·정렬 (저장됨)">
        ⊞ 보기
      </button>
      {open && (
        <>
          <div className="plan-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="plan-menu">
            <div className="plan-menu-label">펼치는 방향</div>
            <div className="plan-menu-dirs">
              {DIRS.map((d) => (
                <button
                  key={d.k}
                  className={`plan-menu-dir ${dir === d.k ? "on" : ""}`}
                  onClick={() => onSetDir(d.k)}
                >
                  <span className="plan-menu-icon">{d.icon}</span>
                  {d.label}
                </button>
              ))}
            </div>
            <div className="plan-menu-label">정렬 기준</div>
            <select
              className="plan-menu-sel"
              value={sort}
              onChange={(e) => onSetSort(e.target.value as PlanSort)}
            >
              <option value="added">추가순</option>
              <option value="title">이름순 (가나다)</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}

/** Edit a step's instruction (prompt). The graph node's title is derived from the
 *  instruction's first line — one field to edit instead of a title/prompt pair. */
function StepEditor({
  step,
  onClose,
  onSave,
}: {
  step: PlanStep;
  onClose: () => void;
  onSave: (patch: { title: string; prompt: string }) => void;
}) {
  const [prompt, setPrompt] = useState(step.prompt);
  const save = () => {
    const firstLine = prompt.trim().split("\n")[0].trim();
    const title = (firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine) || step.title;
    onSave({ title, prompt });
  };
  return (
    <div className="plan-rd-overlay" onMouseDown={onClose}>
      <div className="plan-se" onMouseDown={(e) => e.stopPropagation()}>
        <div className="plan-rd-head">소블럭 편집</div>
        <label className="plan-se-label">지시문 (세션에 전달될 prompt)</label>
        <textarea
          className="plan-se-prompt"
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="이 소블럭을 수행할 세션에게 줄 지시문"
        />
        <div className="plan-rd-actions">
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" onClick={save}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}

/** Hybrid target picker: a quick preset, with optional per-step overrides. */
function RunDialog({
  steps,
  terminals,
  statuses,
  gitRepo,
  onClose,
  onRun,
}: {
  steps: PlanStep[];
  terminals: Terminal[];
  statuses: Record<string, TermStatus>;
  gitRepo: boolean | null;
  onClose: () => void;
  onRun: (target: RunTarget) => void;
}) {
  const [preset, setPreset] = useState<"each-new" | "one-new" | "existing">("each-new");
  const [existingTerm, setExistingTerm] = useState(terminals[0]?.id ?? "");
  const [perStep, setPerStep] = useState(false);
  const [auto, setAuto] = useState(true);
  const [worktree, setWorktree] = useState(false);
  const [effort, setEffort] = useState<ClaudeEffort | "">(""); // "" = inherit settings.json
  const [assign, setAssign] = useState<Record<string, string>>({}); // stepId -> "inherit" | "new" | termId
  const wtDisabled = gitRepo === false;

  const run = () => {
    const base = { auto, worktree, effort: effort || undefined };
    if (worktree) {
      // worktree mode: each step gets its own worktree regardless of preset
      onRun({ mode: "each-new", ...base });
      return;
    }
    if (!perStep) {
      if (preset === "existing") {
        if (!existingTerm) return;
        onRun({ mode: "existing", termId: existingTerm, ...base });
      } else {
        onRun({ mode: preset, ...base });
      }
      return;
    }
    const inherit = preset === "existing" ? existingTerm || "new" : "new";
    const a: Record<string, string> = {};
    for (const s of steps) {
      const v = assign[s.id] ?? "inherit";
      a[s.id] = v === "inherit" ? inherit : v;
    }
    onRun({ mode: "per-step", assign: a, ...base });
  };

  const MODES = [
    { k: "each-new", t: "각각 새 세션", s: "병렬 실행, 의존 순서는 지킴" },
    { k: "one-new", t: "하나의 새 세션", s: "한 세션에서 순차 실행" },
    { k: "existing", t: "기존 세션", s: "이미 떠 있는 세션에 보내기" },
  ] as const;

  return (
    <div className="plan-rd-overlay" onMouseDown={onClose}>
      <div className="plan-rd" onMouseDown={(e) => e.stopPropagation()}>
        <div className="plan-rd-head">
          <span className="plan-rd-count">{steps.length}</span> 개 소블럭 실행
        </div>

        {/* worktree mode — recommended for plans */}
        <button
          type="button"
          className={`plan-rd-wtcard ${worktree ? "on" : ""} ${wtDisabled ? "disabled" : ""}`}
          disabled={wtDisabled}
          onClick={() => !wtDisabled && setWorktree((w) => !w)}
        >
          <span className="plan-rd-wticon">⎇</span>
          <span className="plan-rd-wtbody">
            <span className="plan-rd-wttitle">
              git worktree 모드
              {wtDisabled ? (
                <span className="plan-rd-tag off">사용 불가</span>
              ) : (
                <span className="plan-rd-tag">추천</span>
              )}
            </span>
            <span className="plan-rd-wtsub">
              {wtDisabled ? (
                "이 폴더는 git 저장소가 아니라 worktree 모드를 쓸 수 없어요. (git init 후 사용 가능)"
              ) : gitRepo === null ? (
                "git 저장소 확인 중…"
              ) : (
                <>
                  소블럭마다 자체 worktree에서 실행 → 커밋·통합 브랜치 병합 →{" "}
                  <b>완료되면 현재 브랜치로 자동 병합</b>. 충돌은 Claude가 해결.
                </>
              )}
            </span>
          </span>
          {!wtDisabled && (
            <span className={`plan-rd-toggle ${worktree ? "on" : ""}`}>
              <span className="plan-rd-knob" />
            </span>
          )}
        </button>

        {/* where to run (non-worktree) */}
        <div className={`plan-rd-modes ${worktree ? "dim" : ""}`}>
          <div className="plan-rd-modes-label">실행 위치</div>
          {MODES.map((m) => (
            <button
              type="button"
              key={m.k}
              className={`plan-rd-card ${!worktree && preset === m.k ? "sel" : ""}`}
              disabled={worktree}
              onClick={() => setPreset(m.k)}
            >
              <span className={`plan-rd-radio ${preset === m.k ? "on" : ""}`} />
              <span className="plan-rd-cardbody">
                <span className="plan-rd-cardtitle">{m.t}</span>
                <span className="plan-rd-cardsub">{m.s}</span>
              </span>
              {m.k === "existing" && preset === "existing" && (
                <select
                  className="plan-rd-sel"
                  value={existingTerm}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setExistingTerm(e.target.value)}
                >
                  {terminals.length === 0 && <option value="">(세션 없음)</option>}
                  {terminals.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} {statuses[t.id] ? `· ${statuses[t.id]}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </button>
          ))}

          <label className="plan-rd-perstep">
            <input
              type="checkbox"
              checked={perStep}
              disabled={worktree}
              onChange={(e) => setPerStep(e.target.checked)}
            />
            소블럭별로 개별 지정
          </label>
          {!worktree && perStep && (
            <div className="plan-rd-list">
              {steps.map((s) => (
                <div key={s.id} className="plan-rd-row">
                  <span className="plan-rd-step" title={s.prompt}>
                    {s.title}
                  </span>
                  <select
                    value={assign[s.id] ?? "inherit"}
                    onChange={(e) => setAssign((m) => ({ ...m, [s.id]: e.target.value }))}
                  >
                    <option value="inherit">기본값 따름</option>
                    <option value="new">새 세션</option>
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="plan-rd-switch">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>자동 승인 — 새 세션을 권한 확인(Enter) 없이 진행</span>
        </label>

        <label className="plan-rd-effort">
          <span>추론 강도 (effort)</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value as ClaudeEffort | "")}>
            <option value="">기본 (settings.json)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
          <span className="plan-rd-effort-hint">새로 띄우는 세션에만 적용</span>
        </label>

        <div className="plan-rd-actions">
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn primary" onClick={run}>
            {worktree ? "worktree로 실행" : "실행"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Visual treatment for one log entry, derived from its phase (+ where it came
// from, to tell a clean merge apart from a conflict-resolved one).
function logLine(e: WtLogEntry): { icon: string; cls: string; text: string } {
  switch (e.phase) {
    case "running":
      return { icon: "▶", cls: "go", text: "작업 시작" };
    case "committing":
      return { icon: "•", cls: "go", text: "커밋" };
    case "merging":
      return { icon: "⇗", cls: "go", text: "통합 브랜치에 병합" };
    case "resolving":
      return { icon: "⚠", cls: "warn", text: "병합 충돌 — Claude가 해결 중" };
    case "done":
      return {
        icon: "✓",
        cls: "ok",
        text: e.from === "resolving" ? "충돌 해결 후 병합 완료" : "병합 완료",
      };
    case "error":
      return { icon: "✕", cls: "err", text: e.note || "오류" };
    case "final":
      return { icon: "🏁", cls: "final", text: e.note || "완료" };
    default:
      return { icon: "•", cls: "muted", text: PHASE_LABEL[e.phase as WtPhase] ?? "" };
  }
}

const fmtTime = (at: number) =>
  new Date(at).toLocaleTimeString("ko-KR", { hour12: false });

/** Worktree run status + activity timeline. Drives both the live run (with a
 *  stop button) and the last finished/stopped run (dismissable for review). */
function WtLogPanel({
  run,
  live,
  onStop,
  onDismiss,
}: {
  run: WtRun;
  live: boolean;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(true);
  const prog = wtProgress(run);
  const log = run.log ?? [];

  return (
    <div className="plan-wt-banner">
      <div className="plan-wt-bar-row">
        <span className={`plan-wt-dot ${prog.error ? "err" : live && prog.active ? "go" : "idle"}`} />
        <span className="plan-wt-label">
          {live ? "worktree 실행" : "지난 실행"} · <code>{run.branch}</code>
          <button
            className="plan-wt-open"
            title={`워크트리 폴더 열기 — ${run.cwd}/.fleet/wt`}
            onClick={() => openPath(`${run.cwd}/.fleet/wt`)}
          >
            📂
          </button>
        </span>
        <div className="plan-bar plan-wt-bar">
          <div
            className="plan-bar-fill"
            style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }}
          />
        </div>
        <span className="plan-wt-stat">
          {prog.done}/{prog.total}
          {live && prog.active ? ` · ${prog.active} 진행` : ""}
          {prog.error ? ` · ${prog.error} 오류` : ""}
        </span>
        <button
          className="plan-wt-toggle"
          onClick={() => setOpen((o) => !o)}
          title={open ? "로그 접기" : "로그 펼치기"}
        >
          {open ? "▾" : "▸"} 로그{log.length ? ` (${log.length})` : ""}
        </button>
        {live ? (
          <button className="btn danger" onClick={onStop}>
            중지
          </button>
        ) : (
          <button className="btn" onClick={onDismiss} title="로그 닫기">
            닫기
          </button>
        )}
      </div>

      {open && (
        <div className="plan-wt-log">
          {log.length === 0 ? (
            <div className="plan-wt-log-empty">아직 기록이 없어요.</div>
          ) : (
            log.map((e, i) => {
              const { icon, cls, text } = logLine(e);
              return (
                <div key={i} className={`plan-wt-log-row ${cls}`}>
                  <span className="plan-wt-log-time">{fmtTime(e.at)}</span>
                  <span className={`plan-wt-log-icon ${cls}`}>{icon}</span>
                  {e.phase !== "final" && <span className="plan-wt-log-step">{e.title}</span>}
                  <span className="plan-wt-log-text">{text}</span>
                  {e.branch && <code className="plan-wt-log-branch">{e.branch}</code>}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
