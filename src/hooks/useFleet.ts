import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { ensureHookInstalled, HookEvent, killSession, sendPrompt } from "../api/pty";
import { loadConfig, saveConfig } from "../api/config";
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
  QueueBoard,
  QueueTask,
  TaskStatus,
  Terminal,
  TermStatus,
  emptyConfig,
} from "../types";
import { useClaudeSessions } from "./useClaudeSessions";

const uid = () => crypto.randomUUID();

const emptyBoard = (): QueueBoard => ({ running: false, lanes: [], tasks: [] });

/** Remove a lane (terminal) from a board: its tasks plus any deps pointing at them. */
function dropLane(board: QueueBoard, termId: string): QueueBoard {
  const removed = new Set(board.tasks.filter((t) => t.laneTermId === termId).map((t) => t.id));
  return {
    ...board,
    lanes: board.lanes.filter((l) => l !== termId),
    tasks: board.tasks
      .filter((t) => t.laneTermId !== termId)
      .map((t) => ({ ...t, deps: t.deps.filter((d) => !removed.has(d)) })),
  };
}

/**
 * Boards as persisted, upgrading a pre-board config: the old per-terminal
 * `queues` map becomes one lane (with its tasks) under each terminal's project.
 */
function migrateBoards(c: FleetConfig): Record<string, QueueBoard> {
  if (c.boards && Object.keys(c.boards).length) return c.boards;
  const legacy = (c as unknown as { queues?: Record<string, { id: string; text: string }[]> })
    .queues;
  const boards: Record<string, QueueBoard> = {};
  if (!legacy) return boards;
  for (const [termId, items] of Object.entries(legacy)) {
    if (!items?.length) continue;
    const term = c.terminals.find((t) => t.id === termId);
    if (!term) continue;
    const b = boards[term.projectId] ?? emptyBoard();
    if (!b.lanes.includes(termId)) b.lanes.push(termId);
    for (const it of items)
      b.tasks.push({ id: it.id ?? uid(), laneTermId: termId, text: it.text, deps: [] });
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
  const loaded = useRef(false);

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

  const { sessions, loading: sessionsLoading, refresh: refreshSessions } = useClaudeSessions(
    activeProjectId,
    config.projects,
  );

  // --- load / persist ---
  useEffect(() => {
    loadConfig().then((c) => {
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
      setConfig({ ...c, layouts, boards });
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
    delete activeTask.current[termId];
    setConfig((c) => {
      const terminals = c.terminals.filter((t) => t.id !== termId);
      // Drop this terminal's lane from the board (and any tasks depending on it).
      const boards = { ...c.boards };
      const board = boards[projectId];
      if (board) boards[projectId] = dropLane(board, termId);
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
  };

  // --- queue board ---
  const patchBoard = (projectId: string, fn: (b: QueueBoard) => QueueBoard) =>
    setConfig((c) => ({
      ...c,
      boards: { ...c.boards, [projectId]: fn(c.boards[projectId] ?? emptyBoard()) },
    }));

  const addLane = (projectId: string, termId: string) =>
    patchBoard(projectId, (b) =>
      b.lanes.includes(termId) ? b : { ...b, lanes: [...b.lanes, termId] },
    );
  const removeLane = (projectId: string, termId: string) => {
    delete activeTask.current[termId];
    const board = configRef.current.boards[projectId];
    if (board) for (const t of board.tasks) if (t.laneTermId === termId) setTaskStat(t.id, null);
    patchBoard(projectId, (b) => dropLane(b, termId));
  };
  const addTask = (projectId: string, termId: string, text: string) =>
    patchBoard(projectId, (b) => ({
      ...b,
      lanes: b.lanes.includes(termId) ? b.lanes : [...b.lanes, termId],
      tasks: [...b.tasks, { id: uid(), laneTermId: termId, text, deps: [] } as QueueTask],
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
      for (const termId of b.lanes) delete activeTask.current[termId];
    }
    setBoardRunning(projectId, false);
  };

  const dispatchTask = (termId: string, task: QueueTask) => {
    sendPrompt(termId, task.text);
    awaiting.current[termId] = true;
    activeTask.current[termId] = task.id;
    setTaskStat(task.id, "running");
    window.setTimeout(() => {
      awaiting.current[termId] = false;
    }, 6000);
  };

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
        for (const termId of board.lanes) {
          // The lane's running task is done when its terminal returns to idle.
          const active = activeTask.current[termId];
          if (active) {
            if (sts[termId] === "idle" && !awaiting.current[termId]) {
              setTaskStat(active, "done");
              delete activeTask.current[termId];
            } else {
              continue; // still working on this lane's task
            }
          }
          if (sts[termId] !== "idle" || awaiting.current[termId]) continue;
          const tstat = taskStatusRef.current;
          const head = board.tasks.find(
            (t) => t.laneTermId === termId && tstat[t.id] !== "done" && tstat[t.id] !== "running",
          );
          if (head && head.deps.every((d) => tstat[d] === "done")) dispatchTask(termId, head);
        }
        // Stop the board once every task has completed.
        if (board.tasks.length && board.tasks.every((t) => taskStatusRef.current[t.id] === "done"))
          setBoardRunning(projectId, false);
      }
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resume = (s: ClaudeSession) => {
    if (!activeProjectId) return;
    // Carry the original session's identity over: name the resumed terminal after
    // its summary (first user message) instead of a fresh "Claude ↺ N" counter.
    const label = s.summary.replace(/\s+/g, " ").trim().slice(0, 24);
    const title = label || "Claude ↺";
    newTerm(activeProjectId, `claude --resume ${s.id}`, "Claude ↺", title);
  };

  const liveByProject = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of config.terminals) {
      if (statuses[t.id] && statuses[t.id] !== "stopped") m[t.projectId] = (m[t.projectId] ?? 0) + 1;
    }
    return m;
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
    sessions,
    sessionsLoading,
    refreshSessions,
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
    addLane,
    removeLane,
    addTask,
    removeTask,
    setTaskDeps,
    toggleBoardRunning,
    resetBoard,
    resume,
  };
}
