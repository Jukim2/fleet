import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { ensureHookInstalled, HookEvent, killSession, sendPrompt } from "../api/pty";
import { loadConfig, saveConfig } from "../api/config";
import { closeWebTab, openWebTab, webEval } from "../api/web";
import { cdpEval, cdpOpen, cdpTargets } from "../api/cdp";
import { clearPlan, plannerPrompt, readPlan } from "../api/planner";
import {
  gitIsRepo,
  wtAdd,
  wtCommit,
  wtHasConflicts,
  wtMerge,
  wtMergeContinue,
  wtRemove,
  wtSetup,
  wtFinalize,
} from "../api/git";
import { buildWtRun, WtRun } from "../lib/worktree";
import { buildInjectJs, embedBlocked, isKnownChatSite } from "../lib/webAdapters";
import { laneLiveTerm } from "../lib/board";
import {
  parsePlanDelta,
  mergePlan,
  normalizePlan,
  removeNode,
  type RunTarget,
  buildRunBoard,
} from "../lib/plan";
import {
  compact,
  firstLeaf,
  leaves,
  newLeaf,
  normalize,
  removeLeaf,
  setLeafTerm,
  setRatio,
  splitLeafWith,
  splitLeafWithSide,
} from "../lib/layout";
import {
  Block,
  ClaudeSession,
  FleetConfig,
  LayoutNode,
  Project,
  Lane,
  LaneTarget,
  Plan,
  QueueBoard,
  QueueTask,
  TaskStatus,
  Terminal,
  TermStatus,
  WebTab,
  emptyConfig,
} from "../types";
import { useClaudeSessions } from "./useClaudeSessions";

const uid = () => crypto.randomUUID();

const emptyBoard = (): QueueBoard => ({ running: false, lanes: [], tasks: [] });

/** Remove a lane (track) from a board: its tasks plus any deps pointing at them. */
function dropLane(board: QueueBoard, laneId: string): QueueBoard {
  const removed = new Set(board.tasks.filter((t) => t.laneId === laneId).map((t) => t.id));
  return {
    ...board,
    lanes: board.lanes.filter((l) => l.id !== laneId),
    tasks: board.tasks
      .filter((t) => t.laneId !== laneId)
      .map((t) => ({ ...t, deps: t.deps.filter((d) => !removed.has(d)) })),
  };
}

/** Upgrade a persisted board to the current lane-as-track shape: old boards had
 *  `lanes: termId[]` and `tasks[].laneTermId`; lanes are now `{id,title,target}`
 *  objects and tasks reference `laneId`. */
function upgradeBoard(b: unknown, terminals: Terminal[]): QueueBoard {
  const raw = b as {
    running?: boolean;
    lanes?: unknown[];
    tasks?: { id: string; laneTermId?: string; laneId?: string; text: string; deps?: string[] }[];
  };
  const lanes: Lane[] = (raw.lanes ?? []).map((l) =>
    typeof l === "string"
      ? {
          id: l,
          title: terminals.find((t) => t.id === l)?.title ?? "터미널",
          target: { kind: "session", termId: l } as LaneTarget,
        }
      : (l as Lane),
  );
  const tasks: QueueTask[] = (raw.tasks ?? []).map((t) =>
    t.laneId !== undefined
      ? (t as QueueTask)
      : { id: t.id, laneId: t.laneTermId ?? "", text: t.text, deps: t.deps ?? [] },
  );
  return { running: !!raw.running, lanes, tasks };
}

/**
 * Boards as persisted, upgrading old shapes: existing boards are migrated to the
 * lane-as-track model; a pre-board `queues` map becomes one session lane per
 * terminal.
 */
function migrateBoards(c: FleetConfig): Record<string, QueueBoard> {
  const boards: Record<string, QueueBoard> = {};
  for (const [pid, b] of Object.entries(c.boards ?? {})) boards[pid] = upgradeBoard(b, c.terminals);
  if (Object.keys(boards).length) return boards;

  const legacy = (c as unknown as { queues?: Record<string, { id: string; text: string }[]> })
    .queues;
  if (!legacy) return boards;
  for (const [termId, items] of Object.entries(legacy)) {
    if (!items?.length) continue;
    const term = c.terminals.find((t) => t.id === termId);
    if (!term) continue;
    const b = boards[term.projectId] ?? emptyBoard();
    if (!b.lanes.some((l) => l.id === termId))
      b.lanes.push({ id: termId, title: term.title, target: { kind: "session", termId } });
    for (const it of items)
      b.tasks.push({ id: it.id ?? uid(), laneId: termId, text: it.text, deps: [] });
    boards[term.projectId] = b;
  }
  return boards;
}

/** Central store: owns config + per-session UI state and every mutation. */
export function useFleet() {
  const [config, setConfig] = useState<FleetConfig>(emptyConfig);
  const [statuses, setStatuses] = useState<Record<string, TermStatus>>({});
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [visited, setVisited] = useState<Record<string, boolean>>({});
  const [focusedPane, setFocusedPane] = useState<Record<string, string>>({});
  /** live per-task run state for boards (absent = pending) */
  const [taskStatus, setTaskStatus] = useState<Record<string, TaskStatus>>({});
  /** projectId currently having its plan generated (for a spinner), else null */
  const [planning, setPlanning] = useState<string | null>(null);
  const genTimer = useRef<number | null>(null);
  const loaded = useRef(false);

  /** live worktree-pipeline runs, keyed by projectId (non-persisted) */
  const [wtRuns, setWtRuns] = useState<Record<string, WtRun>>({});
  const wtRunsRef = useRef(wtRuns);
  wtRunsRef.current = wtRuns;
  /** transient note shown in the plan view (e.g. "not a git repo") */
  const [wtMsg, setWtMsg] = useState<Record<string, string>>({});
  /** per-step orchestration flags for the wt runner */
  const wtSent = useRef<Record<string, boolean>>({});
  const wtAwait = useRef<Record<string, boolean>>({});
  const wtTick = useRef(false); // re-entrancy lock for the async runner tick
  const wtFinal = useRef<Record<string, boolean>>({}); // finalize-once guard
  const setWtRun = (projectId: string, run: WtRun | null) => {
    setWtRuns((r) => {
      const next = { ...r };
      if (run) next[projectId] = run;
      else delete next[projectId];
      wtRunsRef.current = next;
      return next;
    });
  };

  const configRef = useRef(config);
  configRef.current = config;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const awaiting = useRef<Record<string, boolean>>({});
  /** terminals whose status is driven by live Claude Code hooks (not screen-scan) */
  const hookDriven = useRef<Record<string, boolean>>({});
  /** whether OS notification permission was granted (set once on mount) */
  const notifyGranted = useRef(false);
  /** which board task each terminal is currently running (termId -> taskId) */
  const activeTask = useRef<Record<string, string>>({});
  /** authoritative mirror of taskStatus the 1s runner reads (kept in sync below) */
  const taskStatusRef = useRef(taskStatus);
  const setTaskStat = (taskId: string, status: TaskStatus | null) => {
    const next = { ...taskStatusRef.current };
    if (status) next[taskId] = status;
    else delete next[taskId];
    taskStatusRef.current = next;
    setTaskStatus(next);
  };

  const {
    sessions,
    loading: sessionsLoading,
    refresh: refreshSessions,
    remove: removeSession,
  } = useClaudeSessions(activeProjectId, config.projects);

  /** Resume session ids that already have a terminal tab in the active project,
   *  mapped to that terminal — so the rail can mark them and jump instead of
   *  spawning a duplicate `claude --resume`. */
  const openSessionTerm = useMemo(() => {
    const m: Record<string, string> = {};
    if (!activeProjectId) return m;
    for (const t of config.terminals) {
      if (t.projectId !== activeProjectId) continue;
      const match = /^claude --resume (\S+)/.exec(t.startup);
      if (match) m[match[1]] = t.id;
    }
    return m;
  }, [activeProjectId, config.terminals]);

  // --- load / persist ---
  useEffect(() => {
    loadConfig().then((c) => {
      // Worktree-run sessions are ephemeral (their cwd is a worktree that gets
      // pruned). Drop any that lingered from a previous session so we don't try
      // to respawn into a missing directory.
      c.terminals = c.terminals.filter((t) => !(t.cwd && t.cwd.includes("/.fleet/wt/")));
      const valid = new Set(c.terminals.map((t) => t.id));
      const layouts: Record<string, LayoutNode | null> = {};
      const focus: Record<string, string> = {};
      for (const p of c.projects) {
        const firstTerm = c.terminals.find((t) => t.projectId === p.id);
        const lay =
          normalize(c.layouts?.[p.id], valid) ?? (firstTerm ? newLeaf(firstTerm.id) : null);
        layouts[p.id] = lay;
        if (lay) focus[p.id] = firstLeaf(lay).id;
      }
      const boards = migrateBoards(c);
      const plans: Record<string, Plan> = {};
      for (const [pid, p] of Object.entries(c.plans ?? {})) plans[pid] = normalizePlan(p);
      setConfig({ ...c, layouts, boards, plans });
      setFocusedPane(focus);
      const first = c.projects[0]?.id ?? null;
      setActiveProjectId(first);
      if (first) setVisited({ [first]: true });
      loaded.current = true;
    });
  }, []);

  useEffect(() => {
    if (loaded.current) saveConfig(config);
  }, [config]);

  // Keep the resume list fresh without a manual ⟳. When a Claude turn finishes
  // (a terminal returns to idle) its transcript was just written, so re-read the
  // active project's sessions shortly after any of its terminals goes idle.
  const prevStatusesRef = useRef<Record<string, TermStatus>>({});
  useEffect(() => {
    const prev = prevStatusesRef.current;
    prevStatusesRef.current = statuses;
    if (!activeProjectId) return;
    const becameIdle = config.terminals.some(
      (t) => t.projectId === activeProjectId && statuses[t.id] === "idle" && prev[t.id] !== "idle",
    );
    if (!becameIdle) return;
    const h = window.setTimeout(() => refreshSessions(), 1200);
    return () => window.clearTimeout(h);
  }, [statuses, activeProjectId, config.terminals, refreshSessions]);

  // --- helpers ---
  const setStatus = (id: string, status: TermStatus) => {
    // Once Claude Code hooks are proven live for a terminal they're
    // authoritative; ignore the screen-scan heuristic (but always honor a real
    // PTY exit → "stopped").
    if (hookDriven.current[id] && status !== "stopped") return;
    if (status === "busy") awaiting.current[id] = false;
    setStatuses((s) => ({ ...s, [id]: status }));
  };
  const patchLayout = (projectId: string, fn: (n: LayoutNode | null) => LayoutNode | null) =>
    setConfig((c) => ({ ...c, layouts: { ...c.layouts, [projectId]: fn(c.layouts[projectId]) } }));
  /** The focused pane id, validated against the current layout; null when there are no panes. */
  const focusOf = (projectId: string): string | null => {
    const lay = config.layouts[projectId];
    if (!lay) return null;
    const stored = focusedPane[projectId];
    if (stored && leaves(lay).some((l) => l.id === stored)) return stored;
    return firstLeaf(lay).id;
  };

  const focusedTermId = useMemo(() => {
    if (!activeProjectId) return null;
    const lay = config.layouts[activeProjectId];
    if (!lay) return null;
    const ls = leaves(lay);
    const stored = focusedPane[activeProjectId];
    const paneId = stored && ls.some((l) => l.id === stored) ? stored : firstLeaf(lay).id;
    return ls.find((l) => l.id === paneId)?.termId ?? null;
  }, [activeProjectId, config.layouts, focusedPane]);
  const focusedTerm = config.terminals.find((t) => t.id === focusedTermId) ?? null;

  // --- projects ---
  const selectProject = (id: string) => {
    setActiveProjectId(id);
    setVisited((v) => (v[id] ? v : { ...v, [id]: true }));
  };
  const addProject = (path: string) => {
    const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
    const project: Project = { id: uid(), name, path };
    const term: Terminal = { id: uid(), projectId: project.id, title: "Claude 1", startup: "claude" };
    const leaf = newLeaf(term.id);
    setConfig((c) => ({
      ...c,
      projects: [...c.projects, project],
      terminals: [...c.terminals, term],
      layouts: { ...c.layouts, [project.id]: leaf },
    }));
    setFocusedPane((f) => ({ ...f, [project.id]: leaf.id }));
    setActiveProjectId(project.id);
    setVisited((v) => ({ ...v, [project.id]: true }));
  };
  const removeProject = (id: string) => {
    config.terminals.filter((t) => t.projectId === id).forEach((t) => killSession(t.id));
    setConfig((c) => {
      const layouts = { ...c.layouts };
      delete layouts[id];
      const boards = { ...c.boards };
      delete boards[id];
      return {
        ...c,
        projects: c.projects.filter((p) => p.id !== id),
        terminals: c.terminals.filter((t) => t.projectId !== id),
        layouts,
        boards,
      };
    });
    if (activeProjectId === id) {
      const next = config.projects.find((p) => p.id !== id)?.id ?? null;
      setActiveProjectId(next);
      if (next) setVisited((v) => ({ ...v, [next]: true }));
    }
  };
  /** Point an existing project at a new folder (e.g. after it moved/renamed).
   *  Only affects terminals spawned afterwards — running PTYs keep their cwd. */
  const relinkProject = (id: string, newPath: string) => {
    const name = newPath.split(/[\\/]/).filter(Boolean).pop() || newPath;
    setConfig((c) => ({
      ...c,
      projects: c.projects.map((p) => (p.id === id ? { ...p, path: newPath, name } : p)),
    }));
  };
  const reorderProjects = (fromId: string, toId: string) =>
    setConfig((c) => {
      const arr = [...c.projects];
      const fi = arr.findIndex((p) => p.id === fromId);
      const ti = arr.findIndex((p) => p.id === toId);
      if (fi < 0 || ti < 0) return c;
      const [m] = arr.splice(fi, 1);
      arr.splice(ti, 0, m);
      return { ...c, projects: arr };
    });

  // --- terminals ---
  const newTerm = (projectId: string, startup: string, baseTitle: string, exactTitle?: string) => {
    const n = config.terminals.filter((t) => t.projectId === projectId).length + 1;
    const title = exactTitle ?? `${baseTitle} ${n}`;
    const term: Terminal = { id: uid(), projectId, title, startup };
    const focus = focusOf(projectId);
    if (focus) {
      patchLayout(projectId, (lay) => (lay ? setLeafTerm(lay, focus, term.id) : newLeaf(term.id)));
    } else {
      // No panes yet → open the new terminal in a fresh pane.
      const leaf = newLeaf(term.id);
      patchLayout(projectId, () => leaf);
      setFocusedPane((fp) => ({ ...fp, [projectId]: leaf.id }));
    }
    setConfig((c) => ({ ...c, terminals: [...c.terminals, term] }));
  };
  const activateTerm = (projectId: string, termId: string) => {
    const focus = focusOf(projectId);
    if (focus) {
      // compact: if the term was already shown elsewhere, drop that now-empty pane.
      patchLayout(projectId, (lay) =>
        lay ? compact(setLeafTerm(lay, focus, termId)) : newLeaf(termId),
      );
    } else {
      const leaf = newLeaf(termId);
      patchLayout(projectId, () => leaf);
      setFocusedPane((fp) => ({ ...fp, [projectId]: leaf.id }));
    }
  };
  const renameTerm = (termId: string, title: string) =>
    setConfig((c) => ({
      ...c,
      terminals: c.terminals.map((t) => (t.id === termId ? { ...t, title } : t)),
    }));
  const closeTerm = (projectId: string, termId: string) => {
    killSession(termId);
    setConfig((c) => {
      const terminals = c.terminals.filter((t) => t.id !== termId);
      // Drop board lanes tied to this terminal: session lanes are removed (with
      // their tasks); spawn lanes that ran in it are unbound so they can respawn.
      const boards = { ...c.boards };
      const board = boards[projectId];
      if (board) {
        let b = board;
        const sessionLaneIds = b.lanes
          .filter((l) => l.target.kind === "session" && l.target.termId === termId)
          .map((l) => l.id);
        for (const lid of sessionLaneIds) {
          delete activeTask.current[lid];
          b = dropLane(b, lid);
        }
        b = {
          ...b,
          lanes: b.lanes.map((l) => {
            if (l.boundTermId !== termId) return l;
            delete activeTask.current[l.id];
            return { ...l, boundTermId: undefined };
          }),
        };
        boards[projectId] = b;
      }
      // Drop the closed terminal's pane (its sibling collapses up — no empty pane).
      let layout = normalize(c.layouts[projectId], new Set(terminals.map((t) => t.id)));
      // If that left no panes but other terminals remain, show one instead of a blank stage.
      if (!layout) {
        const remaining = terminals.find((t) => t.projectId === projectId);
        layout = remaining ? newLeaf(remaining.id) : null;
      }
      return { ...c, terminals, boards, layouts: { ...c.layouts, [projectId]: layout } };
    });
    setStatuses((s) => {
      const next = { ...s };
      delete next[termId];
      return next;
    });
  };
  const reorderTerms = (fromId: string, toId: string) =>
    setConfig((c) => {
      const arr = [...c.terminals];
      const fi = arr.findIndex((t) => t.id === fromId);
      const ti = arr.findIndex((t) => t.id === toId);
      if (fi < 0 || ti < 0) return c;
      const [m] = arr.splice(fi, 1);
      arr.splice(ti, 0, m);
      return { ...c, terminals: arr };
    });

  // --- panes / layout ---
  const focusPane = (projectId: string, paneId: string) =>
    setFocusedPane((f) => ({ ...f, [projectId]: paneId }));
  const setPaneRatio = (projectId: string, splitId: string, ratio: number) =>
    patchLayout(projectId, (n) => (n ? setRatio(n, splitId, ratio) : n));
  const setLeafTermAt = (projectId: string, paneId: string, termId: string) =>
    patchLayout(projectId, (n) => (n ? compact(setLeafTerm(n, paneId, termId)) : n));
  const splitPane = (projectId: string, paneId: string, dir: "row" | "col") => {
    const n = config.terminals.filter((t) => t.projectId === projectId).length + 1;
    const term: Terminal = { id: uid(), projectId, title: `Claude ${n}`, startup: "claude" };
    const sib = newLeaf(term.id);
    setConfig((c) => ({
      ...c,
      terminals: [...c.terminals, term],
      layouts: {
        ...c.layouts,
        [projectId]: c.layouts[projectId]
          ? splitLeafWith(c.layouts[projectId]!, paneId, dir, sib)
          : sib,
      },
    }));
    setFocusedPane((f) => ({ ...f, [projectId]: sib.id }));
  };
  // Close a pane: collapse its space (never leave an empty pane). null = no panes left.
  const closePane = (projectId: string, paneId: string) =>
    patchLayout(projectId, (n) => (n ? removeLeaf(n, paneId) : n));
  const splitWithTerm = (
    projectId: string,
    paneId: string,
    dir: "row" | "col",
    before: boolean,
    termId: string,
  ) =>
    patchLayout(projectId, (n) =>
      n ? compact(splitLeafWithSide(n, paneId, dir, before, newLeaf(termId))) : newLeaf(termId),
    );

  /** Move a whole pane (VS Code-style): dock it onto a target pane, then collapse the old slot. */
  const movePane = (
    projectId: string,
    sourcePaneId: string,
    targetPaneId: string,
    zone: "center" | "left" | "right" | "top" | "bottom",
  ) => {
    if (sourcePaneId === targetPaneId) return;
    patchLayout(projectId, (n) => {
      if (!n) return n;
      const src = leaves(n).find((l) => l.id === sourcePaneId);
      if (!src?.termId) return n;
      const termId = src.termId;
      let next: LayoutNode;
      if (zone === "center") {
        next = setLeafTerm(n, targetPaneId, termId);
      } else {
        const dir = zone === "left" || zone === "right" ? "row" : "col";
        const before = zone === "left" || zone === "top";
        next = splitLeafWithSide(n, targetPaneId, dir, before, newLeaf(termId));
      }
      // The dedup in setLeafTerm/splitLeafWithSide already emptied the source leaf;
      // drop it so its sibling collapses up instead of leaving a blank pane.
      return removeLeaf(next, sourcePaneId) ?? next;
    });
    setFocusedPane((fp) => ({ ...fp, [projectId]: targetPaneId }));
  };

  // --- blocks ---
  const setBlocks = (blocks: Block[]) => setConfig((c) => ({ ...c, blocks }));
  const sendBlock = (b: Block) => {
    if (focusedTermId) sendPrompt(focusedTermId, b.text);
  };
  const broadcastBlock = (b: Block) => {
    for (const t of config.terminals) {
      if (statuses[t.id] && statuses[t.id] !== "stopped") sendPrompt(t.id, b.text);
    }
    // Also fan the prompt out to every open web AI tab.
    broadcastToWebTabs(b.text);
  };

  // --- web tabs (logged-in AI sites) ---
  const addWebTab = (name: string, url: string) =>
    setConfig((c) => ({
      ...c,
      webTabs: [...c.webTabs, { id: uid(), name: name.trim() || url, url: url.trim() }],
    }));
  const removeWebTab = (id: string) => {
    closeWebTab(id).catch(() => {});
    setConfig((c) => ({ ...c, webTabs: c.webTabs.filter((w) => w.id !== id) }));
  };
  const renameWebTab = (id: string, name: string) =>
    setConfig((c) => ({
      ...c,
      webTabs: c.webTabs.map((w) => (w.id === id ? { ...w, name } : w)),
    }));
  /** Open a web tab: embed-blocked sites (ChatGPT) launch in the Fleet-controlled
   *  Chrome (CDP); others open as an embedded webview window. */
  const openTab = (t: WebTab) => {
    if (embedBlocked(t.url)) cdpOpen(t.url).catch(() => {});
    else openWebTab(t.id, t.url, `Fleet · ${t.name}`).catch(() => {});
  };
  const openAllWebTabs = () => configRef.current.webTabs.forEach(openTab);
  /** Inject + submit `text` in one embedded web tab (no-op if not open). */
  const sendToWebTab = (t: WebTab, text: string) =>
    webEval(t.id, buildInjectJs(t.url, text)).catch(() => {});
  /** Inject the prompt into every AI chat tab in the Fleet-controlled Chrome. */
  const cdpBroadcast = async (text: string) => {
    try {
      const targets = await cdpTargets();
      for (const t of targets) {
        if (isKnownChatSite(t.url)) cdpEval(t.ws, buildInjectJs(t.url, text)).catch(() => {});
      }
    } catch {
      /* Chrome not running */
    }
  };
  /** Fan a prompt out to both embedded web tabs AND the real Chrome tabs. */
  const broadcastToWebTabs = (text: string) => {
    configRef.current.webTabs.forEach((t) => sendToWebTab(t, text));
    cdpBroadcast(text);
  };

  // --- queue board ---
  const patchBoard = (projectId: string, fn: (b: QueueBoard) => QueueBoard) =>
    setConfig((c) => ({
      ...c,
      boards: { ...c.boards, [projectId]: fn(c.boards[projectId] ?? emptyBoard()) },
    }));

  /** Add a lane (track): either bound to an existing terminal, or a spawn track
   *  that creates its own session when first run. */
  const addLane = (projectId: string, target: LaneTarget, title: string) =>
    patchBoard(projectId, (b) => {
      if (
        target.kind === "session" &&
        b.lanes.some((l) => l.target.kind === "session" && l.target.termId === target.termId)
      )
        return b; // that terminal is already a lane
      return { ...b, lanes: [...b.lanes, { id: uid(), title, target }] };
    });
  const removeLane = (projectId: string, laneId: string) => {
    delete activeTask.current[laneId];
    const board = configRef.current.boards[projectId];
    if (board) for (const t of board.tasks) if (t.laneId === laneId) setTaskStat(t.id, null);
    patchBoard(projectId, (b) => dropLane(b, laneId));
  };
  const addTask = (projectId: string, laneId: string, text: string) =>
    patchBoard(projectId, (b) => ({
      ...b,
      tasks: [...b.tasks, { id: uid(), laneId, text, deps: [] } as QueueTask],
    }));
  const removeTask = (projectId: string, taskId: string) => {
    setTaskStat(taskId, null);
    patchBoard(projectId, (b) => ({
      ...b,
      tasks: b.tasks
        .filter((t) => t.id !== taskId)
        .map((t) => ({ ...t, deps: t.deps.filter((d) => d !== taskId) })),
    }));
  };
  const setTaskDeps = (projectId: string, taskId: string, deps: string[]) =>
    patchBoard(projectId, (b) => ({
      ...b,
      tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, deps } : t)),
    }));
  const setBoardRunning = (projectId: string, running: boolean) =>
    patchBoard(projectId, (b) => (b.running === running ? b : { ...b, running }));
  const toggleBoardRunning = (projectId: string) =>
    patchBoard(projectId, (b) => ({ ...b, running: !b.running }));
  const resetBoard = (projectId: string) => {
    const b = configRef.current.boards[projectId];
    if (b) {
      const next = { ...taskStatusRef.current };
      for (const t of b.tasks) delete next[t.id];
      taskStatusRef.current = next;
      setTaskStatus(next);
      for (const lane of b.lanes) delete activeTask.current[lane.id];
    }
    setBoardRunning(projectId, false);
  };

  /** Create the session a spawn lane needs (a hidden terminal that mounts and
   *  runs claude/shell), bind it to the lane, and return its id. */
  const spawnLaneTerminal = (projectId: string, lane: Lane): string => {
    const startup = lane.target.kind === "spawn" ? lane.target.startup : "claude";
    const id = uid();
    const term: Terminal = { id, projectId, title: lane.title || "Claude", startup };
    setConfig((c) => ({ ...c, terminals: [...c.terminals, term] }));
    patchBoard(projectId, (b) => ({
      ...b,
      lanes: b.lanes.map((l) => (l.id === lane.id ? { ...l, boundTermId: id } : l)),
    }));
    return id;
  };

  /** Dispatch a task into its lane's resolved terminal. Keyed by lane id. */
  const dispatchTask = (laneId: string, termId: string, task: QueueTask) => {
    sendPrompt(termId, task.text);
    awaiting.current[laneId] = true;
    activeTask.current[laneId] = task.id;
    setTaskStat(task.id, "running");
    window.setTimeout(() => {
      awaiting.current[laneId] = false;
    }, 6000);
  };

  // --- plan (request → auto-decomposed graph → run selection) ---
  const removePlan = (projectId: string) =>
    setConfig((c) => {
      const plans = { ...c.plans };
      delete plans[projectId];
      return { ...c, plans };
    });
  /** Toggle collapse for any plan node (theme or feature) by id. The view passes
   *  the current effective state so the first toggle always flips what's shown. */
  const toggleCollapsed = (projectId: string, nodeId: string, current: boolean) =>
    setConfig((c) => {
      const plan = c.plans[projectId];
      if (!plan) return c;
      const collapsed = { ...(plan.collapsed ?? {}) };
      collapsed[nodeId] = !current;
      return { ...c, plans: { ...c.plans, [projectId]: { ...plan, collapsed } } };
    });
  /** Persist a step's completion into the plan so done-state accumulates in the
   *  graph across runs/restarts (live taskStatus is in-memory only). No-op for
   *  board tasks that aren't plan steps. */
  const markStepDone = (projectId: string, stepId: string) =>
    setConfig((c) => {
      const plan = c.plans[projectId];
      if (!plan || plan.completed?.[stepId] || !plan.steps.some((s) => s.id === stepId)) return c;
      return {
        ...c,
        plans: {
          ...c.plans,
          [projectId]: { ...plan, completed: { ...(plan.completed ?? {}), [stepId]: true } },
        },
      };
    });
  // --- manual plan editing (add / rename / delete nodes by hand) ---
  const editPlan = (projectId: string, fn: (p: Plan) => Plan) =>
    setConfig((c) => {
      const cur = c.plans[projectId] ?? { themes: [], features: [], steps: [] };
      return { ...c, plans: { ...c.plans, [projectId]: fn(cur) } };
    });
  const addTheme = (projectId: string, title = "새 테마") =>
    editPlan(projectId, (p) => ({ ...p, themes: [...p.themes, { id: uid(), title }] }));
  const addFeature = (projectId: string, themeId: string, title = "새 기능") =>
    editPlan(projectId, (p) => ({ ...p, features: [...p.features, { id: uid(), themeId, title }] }));
  const addStep = (projectId: string, featureId: string, title = "새 단계") =>
    editPlan(projectId, (p) => ({
      ...p,
      steps: [...p.steps, { id: uid(), featureId, title, prompt: "", deps: [] }],
    }));
  const renameNode = (projectId: string, id: string, title: string) =>
    editPlan(projectId, (p) => ({
      ...p,
      themes: p.themes.map((t) => (t.id === id ? { ...t, title } : t)),
      features: p.features.map((f) => (f.id === id ? { ...f, title } : f)),
      steps: p.steps.map((s) => (s.id === id ? { ...s, title } : s)),
    }));
  const editStep = (projectId: string, id: string, patch: { title?: string; prompt?: string }) =>
    editPlan(projectId, (p) => ({
      ...p,
      steps: p.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  const removePlanNode = (projectId: string, id: string) =>
    editPlan(projectId, (p) => removeNode(p, id));

  /** Merge a freshly-read .fleet/plan.json into the project's persistent graph. */
  const mergeRawPlan = (projectId: string, raw: string | null): boolean => {
    const delta = raw ? parsePlanDelta(raw) : null;
    if (!delta) return false;
    setConfig((c) => ({
      ...c,
      plans: { ...c.plans, [projectId]: mergePlan(c.plans[projectId], delta) },
    }));
    return true;
  };

  /** Create a visible terminal (in the focused pane) and return its id. */
  const spawnVisibleTerminal = (projectId: string, startup: string, title: string): string => {
    const id = uid();
    const term: Terminal = { id, projectId, title, startup };
    setConfig((c) => ({ ...c, terminals: [...c.terminals, term] }));
    const focus = focusOf(projectId);
    if (focus) patchLayout(projectId, (lay) => (lay ? setLeafTerm(lay, focus, id) : newLeaf(id)));
    else {
      const leaf = newLeaf(id);
      patchLayout(projectId, () => leaf);
      setFocusedPane((fp) => ({ ...fp, [projectId]: leaf.id }));
    }
    return id;
  };

  /** Load an existing .fleet/plan.json from disk and merge it into the plan. */
  const loadPlan = async (projectId: string): Promise<boolean> => {
    const project = configRef.current.projects.find((p) => p.id === projectId);
    if (!project) return false;
    const raw = await readPlan(project.path).catch(() => null);
    return mergeRawPlan(projectId, raw);
  };

  /** Ask a planner Claude to decompose `goal` into .fleet/plan.json, then load it. */
  const requestPlan = (projectId: string, goal: string) => {
    const project = configRef.current.projects.find((p) => p.id === projectId);
    if (!project || !goal.trim()) return;
    const cwd = project.path;
    if (genTimer.current) window.clearInterval(genTimer.current);
    setPlanning(projectId);
    clearPlan(cwd).catch(() => {});
    // Planner runs in acceptEdits mode so it can write .fleet/plan.json without
    // a manual permission Enter — it only reads the repo and writes one file.
    const termId = spawnVisibleTerminal(projectId, "claude --permission-mode acceptEdits", "Planner");
    let sent = false;
    let tries = 0;
    const stop = () => {
      if (genTimer.current) {
        window.clearInterval(genTimer.current);
        genTimer.current = null;
      }
      setPlanning(null);
    };
    genTimer.current = window.setInterval(async () => {
      tries++;
      if (!sent) {
        // wait for the planner session to come up, then send the planner prompt
        if (statusesRef.current[termId] === "idle") {
          const existingThemes = (configRef.current.plans[projectId]?.themes ?? []).map((t) => t.title);
          sendPrompt(termId, plannerPrompt(goal, existingThemes));
          sent = true;
          tries = 0;
        } else if (tries > 45) {
          stop(); // ~90s and claude never became ready
        }
        return;
      }
      const raw = await readPlan(cwd).catch(() => null);
      if (mergeRawPlan(projectId, raw)) {
        stop();
      } else if (tries > 150) {
        stop(); // ~5min timeout
      }
    }, 2000);
  };

  /** Run a selection of plan steps. Worktree mode → the git pipeline runner;
   *  otherwise project them onto the board engine. */
  const runSteps = (projectId: string, stepIds: string[], target: RunTarget) => {
    const plan = configRef.current.plans[projectId];
    if (!plan || !stepIds.length) return;
    if (target.worktree) {
      startWtRun(projectId, stepIds, !!target.auto);
      return;
    }
    const termTitle = (id: string) =>
      configRef.current.terminals.find((t) => t.id === id)?.title ?? "세션";
    const { lanes, tasks } = buildRunBoard(plan, stepIds, target, termTitle);
    const next = { ...taskStatusRef.current };
    for (const id of stepIds) delete next[id];
    taskStatusRef.current = next;
    setTaskStatus(next);
    for (const lane of lanes) delete activeTask.current[lane.id];
    patchBoard(projectId, () => ({ running: true, lanes, tasks }));
  };

  // --- worktree pipeline ---
  /** Create a hidden session bound to a specific cwd (a git worktree dir). */
  const spawnWorktreeTerminal = (projectId: string, startup: string, title: string, cwd: string) => {
    const id = uid();
    const term: Terminal = { id, projectId, title, startup, cwd };
    setConfig((c) => ({ ...c, terminals: [...c.terminals, term] }));
    return id;
  };
  /** Place an existing terminal into the project's focused pane so it's visible. */
  const revealTerm = (projectId: string, termId: string) => {
    setVisited((v) => ({ ...v, [projectId]: true }));
    const focus = focusOf(projectId);
    if (focus) patchLayout(projectId, (lay) => (lay ? setLeafTerm(lay, focus, termId) : newLeaf(termId)));
    else {
      const leaf = newLeaf(termId);
      patchLayout(projectId, () => leaf);
      setFocusedPane((fp) => ({ ...fp, [projectId]: leaf.id }));
    }
  };

  const RESOLVE_PROMPT =
    "이 git 워크트리에 병합 충돌(conflict)이 있어. 충돌난 파일들을 올바르게 통합해서 해결해줘. " +
    "기존 동작이 깨지지 않게 신경 쓰고, 파일 변경만 저장하면 돼 (commit은 Fleet이 마무리할게).";

  /** Start a worktree-pipeline run for the selected steps. */
  const startWtRun = async (projectId: string, stepIds: string[], auto: boolean) => {
    const project = configRef.current.projects.find((p) => p.id === projectId);
    const plan = configRef.current.plans[projectId];
    if (!project || !plan) return;
    if (wtRunsRef.current[projectId]) {
      setWtMsg((m) => ({ ...m, [projectId]: "이미 실행 중인 worktree 파이프라인이 있어요." }));
      return;
    }
    const isRepo = await gitIsRepo(project.path).catch(() => false);
    if (!isRepo) {
      setWtMsg((m) => ({ ...m, [projectId]: "이 폴더는 git 저장소가 아니라 worktree 모드를 쓸 수 없어요." }));
      return;
    }
    setWtMsg((m) => ({ ...m, [projectId]: "" }));
    const slug = uid().slice(0, 6);
    const run = buildWtRun(projectId, project.path, plan, stepIds, auto, slug);
    try {
      await wtSetup(run.cwd, run.integDir, run.branch);
    } catch (e) {
      setWtMsg((m) => ({ ...m, [projectId]: `통합 브랜치 생성 실패: ${String(e)}` }));
      return;
    }
    setWtRun(projectId, run);
  };

  /** Stop a run: kill its sessions and drop the live state. Worktrees/branches
   *  are left on disk (the integration branch holds progress) — user-owned. */
  const stopWtRun = (projectId: string) => {
    const run = wtRunsRef.current[projectId];
    if (!run) return;
    for (const s of run.steps) {
      if (s.termId) closeTerm(projectId, s.termId);
      if (s.resolveTermId) closeTerm(projectId, s.resolveTermId);
    }
    setWtRun(projectId, null);
  };
  const clearWtMsg = (projectId: string) => setWtMsg((m) => ({ ...m, [projectId]: "" }));
  /** Reveal a step's live session in a pane (for watching progress). */
  const showWtStep = (projectId: string, termId: string) => revealTerm(projectId, termId);

  // --- Claude Code hook bridge ---
  // Install hooks + ask for notification permission once, then listen for the
  // events the Rust bridge re-emits. These authoritatively drive busy/idle and,
  // crucially, distinguish "waiting on a permission prompt" from "done".
  const notify = (title: string, body: string) => {
    if (!notifyGranted.current) return;
    try {
      sendNotification({ title, body });
    } catch {
      /* notifications unavailable */
    }
  };

  const onHookEvent = (h: HookEvent) => {
    const { termId, event, notificationType } = h;
    let status: TermStatus | null = null;
    if (event === "UserPromptSubmit" || event === "PreToolUse") status = "busy";
    else if (notificationType === "permission_prompt") status = "waiting";
    else if (notificationType === "idle_prompt") status = "idle";
    else if (event === "Stop" || event === "StopFailure") status = "idle";
    if (!status) return;

    hookDriven.current[termId] = true;
    if (status === "busy") awaiting.current[termId] = false;
    setStatuses((s) => (s[termId] === status ? s : { ...s, [termId]: status }));

    const cfg = configRef.current;
    const term = cfg.terminals.find((t) => t.id === termId);
    const project = term && cfg.projects.find((p) => p.id === term.projectId);
    const where = [project?.name, term?.title].filter(Boolean).join(" · ") || "Claude";
    if (status === "waiting") {
      notify("승인 필요", `${where} — 권한 승인을 기다리고 있어요`);
    } else if (status === "idle" && (event === "Stop" || event === "StopFailure")) {
      // Always ping on completion, even if you're looking right at it.
      notify("작업 완료", `${where} — 응답이 끝났어요`);
    }
  };

  useEffect(() => {
    ensureHookInstalled().catch(() => {});
    (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        notifyGranted.current = granted;
      } catch {
        /* no notification backend */
      }
    })();
    const un = listen<HookEvent>("hook-event", (e) => onHookEvent(e.payload));
    return () => {
      un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Board runner: for each running board, advance every lane independently.
  // A lane's head task fires once its deps are all `done` and its terminal is idle,
  // so dep-free lanes run in parallel and dep chains run in order.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const cfg = configRef.current;
      const sts = statusesRef.current;
      for (const projectId of Object.keys(cfg.boards)) {
        const board = cfg.boards[projectId];
        if (!board?.running) continue;
        for (const lane of board.lanes) {
          const laneId = lane.id;
          const termId = laneLiveTerm(lane);
          // The lane's running task is done when its terminal returns to idle.
          const active = activeTask.current[laneId];
          if (active) {
            if (termId && sts[termId] === "idle" && !awaiting.current[laneId]) {
              setTaskStat(active, "done");
              markStepDone(projectId, active);
              delete activeTask.current[laneId];
            } else {
              continue; // still working on this lane's task
            }
          }
          const tstat = taskStatusRef.current;
          const head = board.tasks.find(
            (t) => t.laneId === laneId && tstat[t.id] !== "done" && tstat[t.id] !== "running",
          );
          if (!head || !head.deps.every((d) => tstat[d] === "done")) continue;
          if (!termId) {
            // Spawn lane that hasn't started yet → create its session, then wait
            // for it to come up on a later tick.
            if (lane.target.kind === "spawn" && !lane.boundTermId) spawnLaneTerminal(projectId, lane);
            continue;
          }
          if (sts[termId] !== "idle" || awaiting.current[laneId]) continue;
          dispatchTask(laneId, termId, head);
        }
        // Stop the board once every task has completed.
        if (board.tasks.length && board.tasks.every((t) => taskStatusRef.current[t.id] === "done"))
          setBoardRunning(projectId, false);
      }
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Worktree pipeline runner: drives each step through its lifecycle
  //   pending → (deps merged) → running → committing → merging → done
  //                                                   ↘ conflict → resolving → done
  // Merges into the integration branch are serialized (one at a time) so the
  // integration worktree never sees concurrent merges. The tick is async + locked.
  useEffect(() => {
    const tickWt = async () => {
      if (wtTick.current) return;
      const pids = Object.keys(wtRunsRef.current);
      if (!pids.length) return;
      wtTick.current = true;
      try {
        for (const projectId of pids) {
          const run = wtRunsRef.current[projectId];
          if (!run) continue;
          const sts = statusesRef.current;
          const steps = run.steps.map((s) => ({ ...s }));
          const doneIds = new Set(steps.filter((s) => s.phase === "done").map((s) => s.stepId));
          let busyMerge = steps.some((s) =>
            ["committing", "merging", "resolving"].includes(s.phase),
          );
          let changed = false;
          const stopped = (id?: string) => !!id && sts[id] === "stopped";

          for (const step of steps) {
            if (step.phase === "pending") {
              if (step.deps.every((d) => doneIds.has(d))) {
                try {
                  await wtAdd(run.cwd, step.dir, step.branch, run.branch);
                } catch (e) {
                  step.phase = "error";
                  step.note = String(e);
                  changed = true;
                  continue;
                }
                const startup = run.auto ? "claude --dangerously-skip-permissions" : "claude";
                step.termId = spawnWorktreeTerminal(projectId, startup, `▶ ${step.title}`, step.dir);
                step.phase = "running";
                step.note = "세션 시작";
                wtSent.current[step.stepId] = false;
                changed = true;
              }
            } else if (step.phase === "running" && step.termId) {
              if (stopped(step.termId)) {
                step.phase = "error";
                step.note = "세션 종료됨";
                changed = true;
                continue;
              }
              const st = sts[step.termId];
              if (!wtSent.current[step.stepId]) {
                if (st === "idle") {
                  sendPrompt(step.termId, step.prompt);
                  wtSent.current[step.stepId] = true;
                  wtAwait.current[step.stepId] = true;
                  window.setTimeout(() => (wtAwait.current[step.stepId] = false), 8000);
                  step.note = "작업 진행";
                  changed = true;
                }
              } else if (st === "idle" && !wtAwait.current[step.stepId] && !busyMerge) {
                busyMerge = true;
                step.phase = "committing";
                step.note = "커밋 중";
                changed = true;
                try {
                  await wtCommit(step.dir, `[plan] ${step.title}`);
                  step.phase = "merging";
                  step.note = "병합 중";
                  const res = await wtMerge(run.integDir, step.branch, `Merge: ${step.title}`);
                  if (res.status === "ok") {
                    await wtRemove(run.cwd, step.dir);
                    step.phase = "done";
                    step.note = "";
                    doneIds.add(step.stepId);
                    markStepDone(projectId, step.stepId);
                    if (step.termId) closeTerm(projectId, step.termId);
                    step.termId = undefined;
                  } else {
                    step.resolveTermId = spawnWorktreeTerminal(
                      projectId,
                      "claude --dangerously-skip-permissions",
                      `⚠ ${step.title} 충돌해결`,
                      run.integDir,
                    );
                    step.phase = "resolving";
                    step.note = "충돌 해결 중";
                    wtSent.current[step.stepId + ":r"] = false;
                  }
                } catch (e) {
                  step.phase = "error";
                  step.note = String(e);
                }
              }
            } else if (step.phase === "resolving" && step.resolveTermId) {
              if (stopped(step.resolveTermId)) {
                step.phase = "error";
                step.note = "해결 세션 종료됨";
                changed = true;
                continue;
              }
              const st = sts[step.resolveTermId];
              const rk = step.stepId + ":r";
              if (!wtSent.current[rk]) {
                if (st === "idle") {
                  sendPrompt(step.resolveTermId, RESOLVE_PROMPT);
                  wtSent.current[rk] = true;
                  wtAwait.current[rk] = true;
                  window.setTimeout(() => (wtAwait.current[rk] = false), 8000);
                  changed = true;
                }
              } else if (st === "idle" && !wtAwait.current[rk]) {
                try {
                  const conf = await wtHasConflicts(run.integDir);
                  if (!conf) {
                    await wtMergeContinue(run.integDir);
                    await wtRemove(run.cwd, step.dir);
                    step.phase = "done";
                    step.note = "";
                    doneIds.add(step.stepId);
                    markStepDone(projectId, step.stepId);
                    if (step.resolveTermId) closeTerm(projectId, step.resolveTermId);
                    if (step.termId) closeTerm(projectId, step.termId);
                    step.resolveTermId = undefined;
                    step.termId = undefined;
                  } else {
                    step.phase = "error";
                    step.note = "충돌이 남아있어요 — 직접 해결 필요";
                    if (step.resolveTermId) revealTerm(projectId, step.resolveTermId);
                  }
                } catch (e) {
                  step.phase = "error";
                  step.note = String(e);
                }
                changed = true;
              }
            }
          }

          if (changed && wtRunsRef.current[projectId]) setWtRun(projectId, { ...run, steps });

          // Whole run finished cleanly → auto-merge the integration branch into
          // the current branch, then clear the run so the graph shows the tidy,
          // completed plan (completion is persisted in plan.completed).
          const allDone = steps.length > 0 && steps.every((s) => s.phase === "done");
          const anyErr = steps.some((s) => s.phase === "error");
          if (allDone && !anyErr && !wtFinal.current[projectId]) {
            wtFinal.current[projectId] = true;
            try {
              const res = await wtFinalize(
                run.cwd,
                run.integDir,
                run.branch,
                `Merge plan ${run.branch}`,
              );
              if (res.status === "ok")
                setWtMsg((m) => ({
                  ...m,
                  [projectId]: `✅ 플랜 완료 · ${run.branch}를 현재 브랜치에 병합했어요.`,
                }));
              else if (res.status === "dirty")
                setWtMsg((m) => ({
                  ...m,
                  [projectId]: `플랜 완료. 단, 작업트리에 커밋 안 된 변경이 있어 최종 병합을 건너뛰었어요 — 정리 후 ${run.branch}를 수동 병합하세요.`,
                }));
              else
                setWtMsg((m) => ({
                  ...m,
                  [projectId]: `플랜 완료. 최종 병합에서 충돌이 나 중단했어요 — ${run.branch}를 직접 병합해주세요.`,
                }));
            } catch (e) {
              setWtMsg((m) => ({ ...m, [projectId]: `최종 병합 실패: ${String(e)}` }));
            }
            setWtRun(projectId, null);
            delete wtFinal.current[projectId];
          }
        }
      } finally {
        wtTick.current = false;
      }
    };
    const timer = window.setInterval(() => void tickWt(), 1200);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resume = (s: ClaudeSession) => {
    if (!activeProjectId) return;
    // Already open in a tab? Jump to it instead of spawning a duplicate resume.
    const existing = openSessionTerm[s.id];
    if (existing) {
      activateTerm(activeProjectId, existing);
      return;
    }
    // Carry the original session's identity over: name the resumed terminal after
    // its summary (first user message) instead of a fresh "Claude ↺ N" counter.
    const label = s.summary.replace(/\s+/g, " ").trim().slice(0, 24);
    const title = label || "Claude ↺";
    newTerm(activeProjectId, `claude --resume ${s.id}`, "Claude ↺", title);
  };

  /** Delete a transcript from disk and drop it from the resume list. */
  const deleteSession = (s: ClaudeSession) => {
    removeSession(s);
  };

  const liveByProject = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of config.terminals) {
      if (statuses[t.id] && statuses[t.id] !== "stopped") m[t.projectId] = (m[t.projectId] ?? 0) + 1;
    }
    return m;
  }, [config.terminals, statuses]);

  /** The most attention-worthy live status across each project's terminals, so
   *  the rail can show one colored dot: a project waiting on a permission prompt
   *  outranks a busy one, which outranks idle. Absent = nothing live. */
  const projectStatus = useMemo(() => {
    const rank: Record<string, number> = { idle: 1, busy: 2, waiting: 3 };
    const best: Record<string, TermStatus> = {};
    for (const t of config.terminals) {
      const s = statuses[t.id];
      if (!s || s === "stopped") continue;
      if (!best[t.projectId] || rank[s] > rank[best[t.projectId]]) best[t.projectId] = s;
    }
    return best;
  }, [config.terminals, statuses]);

  return {
    config,
    statuses,
    taskStatus,
    activeProjectId,
    visited,
    focusedPane,
    focusedTermId,
    focusedTerm,
    liveByProject,
    projectStatus,
    sessions,
    sessionsLoading,
    refreshSessions,
    openSessionTerm,
    setStatus,
    selectProject,
    addProject,
    removeProject,
    relinkProject,
    reorderProjects,
    newTerm,
    activateTerm,
    renameTerm,
    closeTerm,
    reorderTerms,
    focusPane,
    setPaneRatio,
    setLeafTermAt,
    splitPane,
    closePane,
    splitWithTerm,
    movePane,
    setBlocks,
    sendBlock,
    broadcastBlock,
    addWebTab,
    removeWebTab,
    renameWebTab,
    openTab,
    openAllWebTabs,
    sendToWebTab,
    broadcastToWebTabs,
    addLane,
    removeLane,
    addTask,
    removeTask,
    setTaskDeps,
    toggleBoardRunning,
    resetBoard,
    planning,
    requestPlan,
    loadPlan,
    runSteps,
    toggleCollapsed,
    addTheme,
    addFeature,
    addStep,
    renameNode,
    editStep,
    removePlanNode,
    wtRuns,
    wtMsg,
    stopWtRun,
    clearWtMsg,
    showWtStep,
    removePlan,
    resume,
    deleteSession,
  };
}
