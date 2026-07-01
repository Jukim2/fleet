import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  ensureHookInstalled,
  HookEvent,
  killSession,
  prepareClaudeAuto,
  sendPrompt,
  writePty,
} from "../api/pty";
import { loadConfig, saveConfig } from "../api/config";
import { runCommand } from "../api/exec";
import { closeWebTab, openWebTab, webEval } from "../api/web";
import { openPath } from "../api/system";
import { clearPlan, plannerPrompt, readPlan } from "../api/planner";
import { clearPreset, presetGenPrompt, readPreset, GeneratedPreset } from "../api/presetgen";
import { presetBody } from "../lib/presets";
import { describeActivity } from "../lib/activity";
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
import { buildWtRun, WtFix, WtLogEntry, WtRun } from "../lib/worktree";
import { buildInjectJs } from "../lib/webAdapters";
import { laneLiveTerm } from "../lib/board";
import {
  parsePlanDelta,
  mergePlan,
  normalizePlan,
  removeNode,
  type RunTarget,
  buildRunBoard,
  claudeStartup,
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
  ClaudeSession,
  FleetConfig,
  LayoutNode,
  Project,
  Lane,
  LaneTarget,
  Plan,
  PlanDir,
  PlanSort,
  PlanViewport,
  Preset,
  PresetBody,
  QueueBoard,
  QueueTask,
  Toast,
  TaskStatus,
  Terminal,
  TermStatus,
  WebTab,
  WebArtifact,
  emptyConfig,
} from "../types";
import { useClaudeSessions } from "./useClaudeSessions";
import { importSessionTranscript } from "../api/claude";

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

/**
 * Presets as persisted, upgrading older shapes into the current model: a global
 * preset is just `{id, name, kind, desc}` and every project carries its OWN body
 * in `presetBodies`. Two upgrades are handled:
 *  - The previous "global default body + per-project override" shape: the old
 *    global `command`/`prompt` is seeded into every existing project's body (so
 *    presets keep running), and `presetOverrides` becomes `presetBodies`.
 *  - The oldest `Record<projectId, Preset[]>` shape: flattened to one global list
 *    (deduped by kind+name), with each project's body preserved per-project.
 */
function migratePresets(c: FleetConfig): {
  presets: Preset[];
  presetBodies: Record<string, Record<string, PresetBody>>;
} {
  const projectIds = (c.projects ?? []).map((p) => p.id);
  const asBody = (kind: Preset["kind"], v: string): PresetBody =>
    kind === "code" ? { command: v } : { prompt: v };

  // Global-array shape (old default-body form, or already current). Fold any
  // old global body into each project's body and ensure `desc`.
  if (Array.isArray(c.presets)) {
    const legacyMap =
      (c as unknown as { presetBodies?: Record<string, Record<string, PresetBody>> }).presetBodies ??
      (c as unknown as { presetOverrides?: Record<string, Record<string, PresetBody>> })
        .presetOverrides ??
      {};
    const presetBodies: Record<string, Record<string, PresetBody>> = {};
    for (const [pid, m] of Object.entries(legacyMap)) presetBodies[pid] = { ...m };

    const presets: Preset[] = c.presets.map((raw) => {
      const p = raw as unknown as Preset & { command?: string; prompt?: string };
      const globalBody = (p.kind === "code" ? p.command : p.prompt)?.trim();
      if (globalBody)
        for (const pid of projectIds) {
          const forProject = (presetBodies[pid] ??= {});
          if (!forProject[p.id]) forProject[p.id] = asBody(p.kind, globalBody);
        }
      return { id: p.id, name: p.name, kind: p.kind, desc: (p.desc ?? p.name ?? "").trim() };
    });
    return { presets, presetBodies };
  }

  // Oldest shape: Record<projectId, Preset[]>.
  const legacy = c.presets as unknown as Record<string, Preset[]> | undefined;
  const presets: Preset[] = [];
  const presetBodies: Record<string, Record<string, PresetBody>> = {};
  if (!legacy) return { presets, presetBodies };

  const byKey = new Map<string, Preset>();
  for (const [projectId, list] of Object.entries(legacy)) {
    for (const raw of list ?? []) {
      const p = raw as unknown as Preset & { command?: string; prompt?: string };
      const body = (p.kind === "code" ? p.command : p.prompt)?.trim() ?? "";
      const key = `${p.kind}\n${p.name.trim().toLowerCase()}`;
      let global = byKey.get(key);
      if (!global) {
        global = { id: uid(), name: p.name, kind: p.kind, desc: (p.desc ?? p.name).trim() };
        byKey.set(key, global);
        presets.push(global);
      }
      if (body) (presetBodies[projectId] ??= {})[global.id] = asBody(p.kind, body);
    }
  }
  return { presets, presetBodies };
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
  /** presetIds whose body is being AI-generated for the active project (spinner) */
  const [presetGen, setPresetGen] = useState<Record<string, boolean>>({});
  /** transient corner toasts (e.g. preset run results), auto-dismissed */
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** files harvested from web tabs (GPT images, etc.) — non-persisted */
  const [artifacts, setArtifacts] = useState<WebArtifact[]>([]);
  /** live "what is this session doing" line per terminal (from PreToolUse) */
  const [activity, setActivity] = useState<Record<string, string>>({});
  const genTimer = useRef<number | null>(null);
  const loaded = useRef(false);

  /** live worktree-pipeline runs, keyed by projectId (non-persisted) */
  const [wtRuns, setWtRuns] = useState<Record<string, WtRun>>({});
  const wtRunsRef = useRef(wtRuns);
  wtRunsRef.current = wtRuns;
  /** the most recently finished/stopped run per project, kept for review until
   *  the next run starts or the user dismisses it (non-persisted). */
  const [wtLastRun, setWtLastRuns] = useState<Record<string, WtRun>>({});
  const setWtLastRun = (projectId: string, run: WtRun) =>
    setWtLastRuns((m) => ({ ...m, [projectId]: run }));
  const clearWtLastRun = (projectId: string) =>
    setWtLastRuns((m) => {
      const next = { ...m };
      delete next[projectId];
      return next;
    });
  /** transient note shown in the plan view (e.g. "not a git repo") */
  const [wtMsg, setWtMsg] = useState<Record<string, string>>({});
  /** a finalize that needs a human/Claude to finish (merge/restore conflict),
   *  per project — drives the "🤖 클로드한테 해결시키기" button (non-persisted). */
  const [wtFix, setWtFix] = useState<Record<string, WtFix>>({});
  const wtFixRef = useRef(wtFix);
  wtFixRef.current = wtFix;
  const clearWtFix = (projectId: string) =>
    setWtFix((m) => {
      const next = { ...m };
      delete next[projectId];
      return next;
    });
  /** prompts queued to auto-submit into a freshly spawned session once it goes
   *  idle (i.e. claude has finished booting). Keyed by termId. */
  const autoSubmit = useRef<Record<string, { text: string; sent: boolean }>>({});
  /** per-step orchestration flags for the wt runner */
  const wtSent = useRef<Record<string, boolean>>({}); // prompt has been typed in
  const wtAwait = useRef<Record<string, boolean>>({}); // post-send grace (conflict-resolve phase)
  const wtStarted = useRef<Record<string, boolean>>({}); // claude confirmed working (busy)
  const wtSpawnAt = useRef<Record<string, number>>({}); // when the session was launched
  const wtSendAt = useRef<Record<string, number>>({}); // when the prompt was last submitted
  const wtTries = useRef<Record<string, number>>({}); // submit-CR retry count
  const wtTick = useRef(false); // re-entrancy lock for the async runner tick
  const wtFinal = useRef<Record<string, boolean>>({}); // finalize-once guard
  const wtLastLog = useRef<Record<string, string>>({}); // last logged phase summary
  const wtTranscript = useRef<Record<string, string>>({}); // termId -> claude transcript path
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
      const { presets, presetBodies } = migratePresets(c);
      const plans: Record<string, Plan> = {};
      for (const [pid, p] of Object.entries(c.plans ?? {})) plans[pid] = normalizePlan(p);
      setConfig({ ...c, layouts, boards, presets, presetBodies, plans });
      setFocusedPane(focus);
      const first = c.projects[0]?.id ?? null;
      setActiveProjectId(first);
      if (first) setVisited({ [first]: true });
      loaded.current = true;
    }).catch((e) => {
      // A failed load must not leave the app stuck on a blank screen: fall back
      // to the empty config (welcome screen) and let the user start fresh.
      console.error("loadConfig failed:", e);
      loaded.current = true;
      setActiveProjectId(null);
    });
  }, []);

  useEffect(() => {
    if (loaded.current) saveConfig(config);
  }, [config]);

  // Auto-submit a queued prompt into a freshly spawned session once it reports
  // idle (claude finished booting). Used by resolveFinalize so the user doesn't
  // have to type the fix request themselves.
  useEffect(() => {
    for (const [termId, p] of Object.entries(autoSubmit.current)) {
      if (p.sent || statuses[termId] !== "idle") continue;
      p.sent = true;
      submitPrompt(termId, p.text);
      window.setTimeout(() => {
        delete autoSubmit.current[termId];
      }, 1500);
    }
  }, [statuses]);

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
  // Fresh focus for the stable hook listener (which closes over first-render vals).
  const focusedRef = useRef<string | null>(null);
  focusedRef.current = focusedTermId;

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

  // --- toasts (transient corner notifications) ---
  const pushToast = (kind: Toast["kind"], text: string, action?: Toast["action"]) => {
    const id = uid();
    setToasts((ts) => [...ts, { id, kind, text, action }]);
    window.setTimeout(
      () => setToasts((ts) => ts.filter((t) => t.id !== id)),
      // actionable pings linger a bit so you can actually click them
      kind === "err" ? 6000 : action ? 7000 : 3200,
    );
  };
  const dismissToast = (id: string) => setToasts((ts) => ts.filter((t) => t.id !== id));

  // --- presets (global name/kind/desc + a per-project AI-generated body) ------

  /** Replace the global preset list. */
  const setGlobalPresets = (presets: Preset[]) => setConfig((c) => ({ ...c, presets }));

  /** Add a global preset (name/kind/desc). Optionally seed its body for one
   *  project right away (`projectId` + `body`); otherwise the body is created
   *  later, per project, via `generatePresetBody`. */
  const addPreset = (
    name: string,
    kind: Preset["kind"],
    description: string,
    projectId?: string,
    body?: string,
  ) => {
    const desc = description.trim();
    const nm = name.trim() || desc.slice(0, 24);
    if (!nm || !desc) return;
    const id = uid();
    setGlobalPresets([...configRef.current.presets, { id, name: nm, kind, desc }]);
    const b = body?.trim();
    if (projectId && b) setPresetBody(projectId, id, kind === "code" ? { command: b } : { prompt: b });
  };

  /** Update a preset's global fields (name/kind/desc). */
  const updatePreset = (presetId: string, patch: Partial<Omit<Preset, "id">>) =>
    setConfig((c) => ({
      ...c,
      presets: c.presets.map((p) => (p.id === presetId ? { ...p, ...patch } : p)),
    }));

  const removePreset = (presetId: string) =>
    setConfig((c) => ({ ...c, presets: c.presets.filter((p) => p.id !== presetId) }));

  /** Set (or clear, when empty) a project's executable body for a preset. */
  const setPresetBody = (projectId: string, presetId: string, body: PresetBody | null) =>
    setConfig((c) => {
      const forProject = { ...(c.presetBodies[projectId] ?? {}) };
      const v = body?.command ?? body?.prompt;
      if (!body || !v?.trim()) delete forProject[presetId];
      else forProject[presetId] = body;
      return { ...c, presetBodies: { ...c.presetBodies, [projectId]: forProject } };
    });

  /** Run a preset using THIS project's body. */
  const runPreset = (projectId: string, presetId: string) => {
    const c = configRef.current;
    const preset = c.presets.find((x) => x.id === presetId);
    if (!preset) return;
    const body = presetBody(preset, c.presetBodies[projectId]?.[presetId]);
    if (!body) {
      pushToast("err", `${preset.name}: 이 프로젝트용 내용이 없어요 — ✨로 생성하세요`);
      return;
    }
    if (preset.kind === "ai") {
      if (focusedTermId) {
        sendPrompt(focusedTermId, body);
        pushToast("ok", `${preset.name} → 현재 터미널`);
      } else {
        pushToast("err", "전송할 터미널이 없어요");
      }
      return;
    }
    // code preset: run the shell command once in the project cwd.
    const project = c.projects.find((pr) => pr.id === projectId);
    if (!project) return;
    // A pending toast (no auto-dismiss) we replace with the result.
    const pending = uid();
    setToasts((ts) => [...ts, { id: pending, kind: "info", text: `${preset.name} 실행 중…` }]);
    runCommand(project.path, body)
      .then(() => {
        dismissToast(pending);
        pushToast("ok", `${preset.name} 완료`);
      })
      .catch((e) => {
        dismissToast(pending);
        pushToast("err", `${preset.name} 실패 — ${String(e).slice(0, 200)}`);
      });
  };

  /** Generate THIS project's body for a preset: spawn a generator Claude, have it
   *  inspect the repo and write `.fleet/preset.json` from the preset's `desc`,
   *  then store the body it produced in `presetBodies`. Mirrors the planner flow. */
  const generatePresetBody = (projectId: string, presetId: string) => {
    const c = configRef.current;
    const preset = c.presets.find((p) => p.id === presetId);
    const project = c.projects.find((p) => p.id === projectId);
    if (!preset || !project) return;
    const description = preset.desc?.trim() || preset.name;
    const cwd = project.path;
    setPresetGen((g) => ({ ...g, [preset.id]: true }));
    clearPreset(cwd).catch(() => {});
    const termId = spawnVisibleTerminal(
      projectId,
      "claude --permission-mode acceptEdits",
      `프리셋: ${preset.name}`,
    );
    let sent = false;
    let tries = 0;
    let timer = 0;
    const stop = () => {
      if (timer) window.clearInterval(timer);
      setPresetGen((g) => {
        const n = { ...g };
        delete n[preset.id];
        return n;
      });
    };
    timer = window.setInterval(async () => {
      tries++;
      if (!sent) {
        if (statusesRef.current[termId] === "idle") {
          sendPrompt(termId, presetGenPrompt(preset.kind, preset.name, description));
          sent = true;
          tries = 0;
        } else if (tries > 45) {
          stop();
          pushToast("err", `${preset.name}: 세션 준비 실패`);
        }
        return;
      }
      const raw = await readPreset(cwd).catch(() => null);
      if (raw) {
        let gen: GeneratedPreset | null = null;
        try {
          gen = JSON.parse(raw);
        } catch {
          gen = null;
        }
        const body = (preset.kind === "code" ? gen?.command : gen?.prompt)?.trim();
        if (body) {
          setPresetBody(
            projectId,
            preset.id,
            preset.kind === "code" ? { command: body } : { prompt: body },
          );
          clearPreset(cwd).catch(() => {});
          stop();
          pushToast("ok", `${preset.name} 생성 완료`);
          return;
        }
      }
      if (tries > 150) {
        stop();
        pushToast("err", `${preset.name}: 생성 시간 초과`);
      }
    }, 2000);
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
  /** Open a web tab as an embedded webview window with its own isolated login
   *  session (profile = tab id). Bot-protected sites (ChatGPT) render fine here
   *  with the spoofed desktop UA, so everything goes through the embed. */
  const openTab = (t: WebTab) => {
    openWebTab(t.id, t.url, `Fleet · ${t.name}`, t.id).catch(() => {});
  };
  const openAllWebTabs = () => configRef.current.webTabs.forEach(openTab);
  /** Inject + submit `text` in one embedded web tab (no-op if not open). */
  const sendToWebTab = (t: WebTab, text: string) =>
    webEval(t.id, buildInjectJs(t.url, text)).catch(() => {});
  /** Fan a prompt out to every open embedded web tab. */
  const broadcastToWebTabs = (text: string) => {
    configRef.current.webTabs.forEach((t) => sendToWebTab(t, text));
  };
  /** A file arrived from a web tab's download interceptor (backend `web-artifact`). */
  const onWebArtifact = (p: { tab: string; path: string; url: string }) => {
    const tabId = p.tab.replace(/^web-/, "");
    const name = p.path.split(/[\\/]/).pop() || "download";
    const art: WebArtifact = {
      id: uid(),
      tabId,
      name,
      path: p.path,
      url: p.url,
      createdAt: Date.now(),
    };
    setArtifacts((a) => [art, ...a].slice(0, 200));
    pushToast("ok", `산출물 저장됨 · ${name}`);
  };
  /** Open a harvested file with the OS default app. */
  const openArtifact = (a: WebArtifact) => openPath(a.path).catch(() => {});
  const clearArtifacts = () => setArtifacts([]);

  // --- queue board ---
  const patchBoard = (projectId: string, fn: (b: QueueBoard) => QueueBoard) =>
    setConfig((c) => ({
      ...c,
      boards: { ...c.boards, [projectId]: fn(c.boards[projectId] ?? emptyBoard()) },
    }));

  const setBoardRunning = (projectId: string, running: boolean) =>
    patchBoard(projectId, (b) => (b.running === running ? b : { ...b, running }));

  /** Abort a non-worktree plan run: stop dispatching, clear live task state.
   *  (Worktree runs have their own stop via the wt pipeline.) */
  const stopBoardRun = (projectId: string) => {
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
  const addTheme = (projectId: string, title = "새 대블럭") =>
    editPlan(projectId, (p) => ({ ...p, themes: [...p.themes, { id: uid(), title }] }));
  // Adding under a done node: that node auto-collapses (done), so a freshly added
  // child would be hidden. Force the parent(s) open so the addition is visible.
  const addFeature = (projectId: string, themeId: string, title = "새 중블럭") =>
    editPlan(projectId, (p) => ({
      ...p,
      features: [...p.features, { id: uid(), themeId, title }],
      collapsed: { ...(p.collapsed ?? {}), [themeId]: false },
    }));
  const addStep = (projectId: string, featureId: string, title = "새 소블럭") =>
    editPlan(projectId, (p) => {
      const themeId = p.features.find((f) => f.id === featureId)?.themeId;
      return {
        ...p,
        steps: [...p.steps, { id: uid(), featureId, title, prompt: "", deps: [] }],
        collapsed: {
          ...(p.collapsed ?? {}),
          [featureId]: false,
          ...(themeId ? { [themeId]: false } : {}),
        },
      };
    });
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
  /** Move a step under a different feature (drag-to-reparent in the plan graph).
   *  Deps are unaffected (they're cross-feature already). Target feature is
   *  force-expanded so the moved step stays visible. */
  const setStepFeature = (projectId: string, stepId: string, featureId: string) =>
    editPlan(projectId, (p) => {
      if (!p.features.some((f) => f.id === featureId)) return p;
      return {
        ...p,
        steps: p.steps.map((s) => (s.id === stepId ? { ...s, featureId } : s)),
        collapsed: { ...(p.collapsed ?? {}), [featureId]: false },
      };
    });
  /** Replace a step's prerequisite list (manual edge editing in the plan graph).
   *  Drops self-refs, unknown ids, and any edge that would introduce a cycle —
   *  the worktree/board runner relies on deps forming a DAG. */
  const setStepDeps = (projectId: string, stepId: string, deps: string[]) =>
    editPlan(projectId, (p) => {
      const byId = new Map(p.steps.map((s) => [s.id, s]));
      if (!byId.has(stepId)) return p;
      const accepted: string[] = [];
      // does `from` (transitively) reach `target`, given stepId's deps = accepted-so-far?
      const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
        if (from === target) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        const ds = from === stepId ? accepted : byId.get(from)?.deps ?? [];
        return ds.some((d) => reaches(d, target, seen));
      };
      for (const d of new Set(deps)) {
        if (d === stepId || !byId.has(d)) continue;
        if (reaches(d, stepId)) continue; // adding d would close a cycle through stepId
        accepted.push(d);
      }
      return { ...p, steps: p.steps.map((s) => (s.id === stepId ? { ...s, deps: accepted } : s)) };
    });

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
      startWtRun(projectId, stepIds, !!target.auto, target.effort);
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

  /** Switch to a terminal's project and bring it into the focused pane. Used by
   *  the attention peek, clickable pings, and the command palette to get you from
   *  "that session needs me" to looking at it in one action, across projects. */
  const jumpToTerm = (projectId: string, termId: string) => {
    selectProject(projectId);
    activateTerm(projectId, termId);
  };

  /** Reveal a terminal in its OWN pane (tile), so parallel worktree steps are all
   *  visible AND get a real PTY size at once — instead of replacing the focused
   *  pane (which would push earlier steps to 0-size and stall them). Fills an
   *  empty pane if one exists, else splits the first pane (alternating dir). */
  const revealTermTiled = (projectId: string, termId: string) => {
    setVisited((v) => ({ ...v, [projectId]: true }));
    patchLayout(projectId, (lay) => {
      if (!lay) return newLeaf(termId);
      const ls = leaves(lay);
      if (ls.some((l) => l.termId === termId)) return lay; // already shown
      const empty = ls.find((l) => !l.termId);
      if (empty) return setLeafTerm(lay, empty.id, termId);
      const dir = ls.length % 2 === 0 ? "col" : "row";
      return splitLeafWith(lay, ls[0].id, dir, newLeaf(termId));
    });
  };

  /** Drive claude's TUI: type the prompt, then submit with a *separate* carriage
   *  return shortly after. Sending text+CR in one burst lets claude absorb the CR
   *  into the (bracketed) paste, so the text lands in the box but never submits. */
  const submitPrompt = (termId: string, text: string) => {
    writePty(termId, text).catch(() => {});
    window.setTimeout(() => writePty(termId, "\r").catch(() => {}), 250);
  };

  /** Copy a finished worktree step's claude transcript into the project's session
   *  folder so it shows up in the resume list (the step's changes are merged, so
   *  it can be continued from the project root). */
  const importStepSession = (projectId: string, termId?: string) => {
    if (!termId) return;
    const transcript = wtTranscript.current[termId];
    if (!transcript) return;
    const project = configRef.current.projects.find((p) => p.id === projectId);
    if (!project) return;
    importSessionTranscript(project.path, transcript)
      .then(() => refreshSessions())
      .catch((e) => console.warn("[wt] import transcript failed", e));
  };

  const RESOLVE_PROMPT =
    "이 git 워크트리에 병합 충돌(conflict)이 있어. 충돌난 파일들을 올바르게 통합해서 해결해줘. " +
    "기존 동작이 깨지지 않게 신경 쓰고, 파일 변경만 저장하면 돼 (commit은 Fleet이 마무리할게).";

  /** Start a worktree-pipeline run for the selected steps. */
  const startWtRun = async (
    projectId: string,
    stepIds: string[],
    auto: boolean,
    effort?: RunTarget["effort"],
  ) => {
    console.log("[wt] startWtRun", { projectId, stepIds, auto, effort });
    const project = configRef.current.projects.find((p) => p.id === projectId);
    const plan = configRef.current.plans[projectId];
    if (!project || !plan) {
      console.warn("[wt] no project/plan");
      return;
    }
    if (wtRunsRef.current[projectId]) {
      setWtMsg((m) => ({ ...m, [projectId]: "이미 실행 중인 worktree 파이프라인이 있어요." }));
      return;
    }
    let isRepo: boolean;
    try {
      isRepo = await gitIsRepo(project.path);
    } catch (e) {
      console.error("[wt] gitIsRepo invoke failed", e);
      setWtMsg((m) => ({
        ...m,
        [projectId]: `git 명령을 호출하지 못했어요 (${String(e)}). 앱을 재빌드/재시작해 보세요.`,
      }));
      return;
    }
    if (!isRepo) {
      setWtMsg((m) => ({ ...m, [projectId]: "이 폴더는 git 저장소가 아니라 worktree 모드를 쓸 수 없어요." }));
      return;
    }
    const slug = uid().slice(0, 6);
    const run = { ...buildWtRun(projectId, project.path, plan, stepIds, auto, slug, effort), startedAt: Date.now() };
    clearWtLastRun(projectId); // a new run supersedes the archived one
    clearWtFix(projectId); // and clears any stuck-merge banner from before
    setWtMsg((m) => ({ ...m, [projectId]: `worktree 파이프라인 시작… (${run.steps.length}개 소블럭, ${run.branch})` }));
    // Pre-clear Claude Code's first-run gates (folder-trust per worktree dir,
    // plus the --dangerously-skip-permissions warning in auto mode) so the
    // sessions don't hang on a startup dialog the runner can't get past.
    try {
      await prepareClaudeAuto([...run.steps.map((s) => s.dir), run.integDir], auto);
    } catch (e) {
      console.warn("[wt] prepareClaudeAuto failed (continuing)", e);
    }
    try {
      await wtSetup(run.cwd, run.integDir, run.branch);
    } catch (e) {
      console.error("[wt] wtSetup failed", e);
      setWtMsg((m) => ({ ...m, [projectId]: `통합 브랜치 생성 실패: ${String(e)}` }));
      return;
    }
    console.log("[wt] run created", run.branch, "steps:", run.steps.map((s) => s.title));
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
    // Archive so the activity log survives a manual stop.
    const stop: WtLogEntry = {
      at: Date.now(),
      title: "실행 중지",
      phase: "final",
      note: "사용자가 실행을 중지했어요.",
    };
    setWtLastRun(projectId, { ...run, log: [...(run.log ?? []), stop] });
    setWtRun(projectId, null);
  };
  const clearWtMsg = (projectId: string) => setWtMsg((m) => ({ ...m, [projectId]: "" }));

  /** Plan-graph card size (persisted in config, applies to all plans). */
  const setPlanCardScale = (scale: number) =>
    setConfig((c) => ({ ...c, planCardScale: Math.max(0.8, Math.min(2, scale)) }));

  /** Persist a project's plan-graph viewport (pan + zoom) so it survives reopen.
   *  Debounced by the caller — the graph writes this on pan/zoom settle, not per frame. */
  const setPlanView = (projectId: string, v: PlanViewport) =>
    setConfig((c) => ({ ...c, planViews: { ...(c.planViews ?? {}), [projectId]: v } }));

  /** Focus the plan graph on a set of 대블럭/중블럭 subtrees (empty = 전체 보기).
   *  Persisted per project so reopening the plan returns to the same blocks. */
  const setPlanFocus = (projectId: string, ids: string[]) =>
    setConfig((c) => ({ ...c, planFocus: { ...(c.planFocus ?? {}), [projectId]: ids } }));

  /** Plan-graph flow direction + sibling order (persisted, applies to all plans). */
  const setPlanDir = (dir: PlanDir) => setConfig((c) => ({ ...c, planDir: dir }));
  const setPlanSort = (sort: PlanSort) => setConfig((c) => ({ ...c, planSort: sort }));

  /** The fix request handed to Claude, tailored to how the final merge got stuck. */
  const finalizeFixPrompt = (fix: WtFix): string => {
    const b = fix.branch;
    if (fix.status === "restore_dirty")
      return (
        `방금 플랜 통합 브랜치 ${b}를 현재 브랜치에 병합했는데, 그 직전에 자동으로 stash 해둔 내 ` +
        `미저장 변경을 복원(git stash pop)하다가 충돌이 났어. 지금 작업트리에 충돌 마커가 남아있고, ` +
        `그 변경은 'fleet-finalize-autostash'라는 이름으로 git stash 에도 그대로 보관돼 있어. ` +
        `충돌 마커를 올바르게 정리해서 병합 결과와 내 변경을 모두 살려 통합하고, 정상 복원이 확인되면 ` +
        `해당 stash 항목을 git stash drop 해줘. 새 커밋은 만들지 마.`
      );
    if (fix.status === "conflict")
      return (
        `플랜 통합 브랜치 ${b}를 현재 브랜치에 병합하려다 충돌이 나서 병합이 취소(abort)된 상태야. ` +
        `작업트리에 커밋 안 한 변경이 있으면 먼저 안전하게 처리(필요하면 stash 후 복원)한 다음, ` +
        `git merge --no-ff ${b} 로 다시 병합하고 충돌난 파일들을 올바르게 통합해서 병합 커밋까지 완료해줘. ` +
        `기존 동작이 깨지지 않게 신경 써줘.`
      );
    // stash_failed
    return (
      `플랜 통합 브랜치 ${b} 가 아직 현재 브랜치에 병합되지 않았어. 작업트리에 커밋 안 한 변경이 있으면 ` +
      `안전하게 처리한 뒤 git merge --no-ff ${b} 로 병합하고, 충돌이 있으면 해결해서 병합을 완료해줘.`
    );
  };

  /** Hand a stuck final merge to a Claude session: spawn it in the repo root,
   *  reveal it, and auto-send a prompt describing exactly what to fix. */
  const resolveFinalize = async (projectId: string) => {
    const fix = wtFixRef.current[projectId];
    if (!fix) return;
    // Clear Claude's first-run gates so an auto session can run git unattended.
    try {
      await prepareClaudeAuto([fix.cwd], true);
    } catch (e) {
      console.warn("[wt] prepareClaudeAuto (resolveFinalize) failed", e);
    }
    const termId = spawnWorktreeTerminal(projectId, claudeStartup(true), "🤖 병합 해결", fix.cwd);
    autoSubmit.current[termId] = { text: finalizeFixPrompt(fix), sent: false };
    revealTerm(projectId, termId);
    clearWtFix(projectId);
    setWtMsg((m) => ({ ...m, [projectId]: `🤖 ${fix.branch} 병합 문제를 해결할 세션을 띄웠어요.` }));
  };

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
    // Remember the claude transcript for this terminal so a finished worktree
    // step can be imported into the project's resume list.
    if (h.transcriptPath) wtTranscript.current[termId] = h.transcriptPath;

    // PreToolUse carries the live "what is it doing" line; update & keep going.
    // A fresh prompt (UserPromptSubmit) clears it so we don't show a stale tool.
    if (event === "PreToolUse") {
      const label = describeActivity(h.toolName, h.toolDetail);
      if (label) setActivity((a) => (a[termId] === label ? a : { ...a, [termId]: label }));
    } else if (event === "UserPromptSubmit") {
      setActivity((a) => {
        if (!(termId in a)) return a;
        const n = { ...a };
        delete n[termId];
        return n;
      });
    }

    let status: TermStatus | null = null;
    if (event === "UserPromptSubmit" || event === "PreToolUse") status = "busy";
    else if (notificationType === "permission_prompt") status = "waiting";
    else if (notificationType === "idle_prompt") status = "idle";
    else if (event === "Stop" || event === "StopFailure") status = "idle";
    if (!status) return;

    hookDriven.current[termId] = true;
    if (status === "busy") awaiting.current[termId] = false;
    // Once a turn ends (idle), there's no live activity to show anymore.
    if (status === "idle")
      setActivity((a) => {
        if (!(termId in a)) return a;
        const n = { ...a };
        delete n[termId];
        return n;
      });
    setStatuses((s) => (s[termId] === status ? s : { ...s, [termId]: status }));

    const cfg = configRef.current;
    const term = cfg.terminals.find((t) => t.id === termId);
    const project = term && cfg.projects.find((p) => p.id === term.projectId);
    const where = [project?.name, term?.title].filter(Boolean).join(" · ") || "Claude";
    // Ping (OS + clickable in-app toast) so parallel sessions surface themselves.
    // Skip the in-app toast for the session you're already looking at.
    const jump = term ? { projectId: term.projectId, termId } : undefined;
    const elsewhere = termId !== focusedRef.current;
    if (status === "waiting") {
      notify("승인 필요", `${where} — 권한 승인을 기다리고 있어요`);
      if (elsewhere) pushToast("info", `${where} — 승인 필요`, jump);
    } else if (status === "idle" && (event === "Stop" || event === "StopFailure")) {
      notify("작업 완료", `${where} — 응답이 끝났어요`);
      if (elsewhere) pushToast("ok", `${where} — 완료`, jump);
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
    const unArt = listen<{ tab: string; path: string; url: string }>(
      "web-artifact",
      (e) => onWebArtifact(e.payload),
    );
    return () => {
      un.then((f) => f());
      unArt.then((f) => f());
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
          // Log phase transitions (not every tick) so the run is traceable.
          const summary = run.steps
            .map((s) => `${s.title}:${s.phase}${s.termId ? `(${sts[s.termId] ?? "?"})` : ""}`)
            .join(" | ");
          if (wtLastLog.current[projectId] !== summary) {
            wtLastLog.current[projectId] = summary;
            console.log("[wt] tick", projectId, summary);
          }
          const steps = run.steps.map((s) => ({ ...s }));
          const doneIds = new Set(steps.filter((s) => s.phase === "done").map((s) => s.stepId));
          const ACTIVE = ["committing", "merging", "resolving"];
          // Merges into the shared integration worktree must be serialized.
          let busyMerge = steps.some((s) => ACTIVE.includes(s.phase));
          let changed = false;
          const now = Date.now();
          const stopped = (id?: string) => !!id && sts[id] === "stopped";

          for (const step of steps) {
            if (step.phase === "pending") {
              // Parallel by design: every step whose deps are merged starts now,
              // each in its own worktree + tiled pane. Merges stay serialized.
              if (step.deps.every((d) => doneIds.has(d))) {
                try {
                  await wtAdd(run.cwd, step.dir, step.branch, run.branch);
                } catch (e) {
                  step.phase = "error";
                  step.note = String(e);
                  changed = true;
                  continue;
                }
                const startup = claudeStartup(run.auto, run.effort);
                // Re-assert the trust gate just before launch: the worktree dir
                // now exists, and another running claude may have rewritten
                // ~/.claude.json since startWtRun, dropping our pre-trust.
                await prepareClaudeAuto([step.dir], run.auto).catch(() => {});
                step.termId = spawnWorktreeTerminal(projectId, startup, `▶ ${step.title}`, step.dir);
                // Tile into its own pane: visible AND a real PTY size, so several
                // steps run concurrently without pushing each other to 0-size.
                revealTermTiled(projectId, step.termId);
                step.phase = "running";
                step.note = "세션 시작";
                wtSent.current[step.stepId] = false;
                wtStarted.current[step.stepId] = false;
                wtSpawnAt.current[step.stepId] = now;
                wtTries.current[step.stepId] = 0;
                changed = true;
                console.log("[wt] spawned step", step.title, "→", step.dir);
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
                // Wait for claude to actually boot before typing: a fresh session
                // reads "idle" off the banner instantly (false-idle). Require a
                // dwell since spawn so we don't type into the splash screen.
                if (st === "idle" && now - (wtSpawnAt.current[step.stepId] ?? 0) > 3000) {
                  console.log("[wt] sending prompt to", step.title);
                  submitPrompt(step.termId, step.prompt);
                  wtSent.current[step.stepId] = true;
                  wtSendAt.current[step.stepId] = now;
                  step.note = "지시 전송";
                  changed = true;
                }
              } else if (!wtStarted.current[step.stepId]) {
                // Confirm the prompt actually submitted: claude flips to busy
                // (UserPromptSubmit/PreToolUse hook). If it's still idle after a
                // grace window, the CR didn't take — resend a lone CR to submit.
                if (st === "busy" || st === "waiting") {
                  wtStarted.current[step.stepId] = true;
                  step.note = "작업 중";
                  changed = true;
                } else if (st === "idle" && now - (wtSendAt.current[step.stepId] ?? 0) > 4000) {
                  const tries = (wtTries.current[step.stepId] ?? 0) + 1;
                  wtTries.current[step.stepId] = tries;
                  if (tries > 3) {
                    step.phase = "error";
                    step.note = "세션이 지시를 받지 못했어요 (제출 실패)";
                    changed = true;
                  } else {
                    console.log("[wt] resend CR to", step.title, `(try ${tries})`);
                    writePty(step.termId, "\r").catch(() => {});
                    wtSendAt.current[step.stepId] = now;
                  }
                }
              } else if (st === "idle" && !busyMerge) {
                // Started, then returned to idle → the turn finished → commit+merge.
                busyMerge = true;
                step.phase = "committing";
                step.note = "커밋 중";
                changed = true;
                try {
                  console.log("[wt] commit+merge", step.title);
                  await wtCommit(step.dir, `[plan] ${step.title}`);
                  step.phase = "merging";
                  step.note = "병합 중";
                  const res = await wtMerge(run.integDir, step.branch, `Merge: ${step.title}`);
                  console.log("[wt] merge result", step.title, res.status);
                  if (res.status === "ok") {
                    await wtRemove(run.cwd, step.dir);
                    step.phase = "done";
                    step.note = "";
                    doneIds.add(step.stepId);
                    markStepDone(projectId, step.stepId);
                    importStepSession(projectId, step.termId);
                    if (step.termId) closeTerm(projectId, step.termId);
                    step.termId = undefined;
                  } else {
                    await prepareClaudeAuto([run.integDir], true).catch(() => {});
                    step.resolveTermId = spawnWorktreeTerminal(
                      projectId,
                      claudeStartup(true, run.effort),
                      `⚠ ${step.title} 충돌해결`,
                      run.integDir,
                    );
                    revealTermTiled(projectId, step.resolveTermId);
                    step.phase = "resolving";
                    step.note = "충돌 해결 중";
                    wtSent.current[step.stepId + ":r"] = false;
                    wtSpawnAt.current[step.stepId + ":r"] = now;
                  }
                } catch (e) {
                  console.error("[wt] commit/merge failed", step.title, e);
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
                if (st === "idle" && now - (wtSpawnAt.current[rk] ?? 0) > 3000) {
                  submitPrompt(step.resolveTermId, RESOLVE_PROMPT);
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
                    importStepSession(projectId, step.termId);
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

          if (changed && wtRunsRef.current[projectId]) {
            // Record every phase transition as a timeline entry so the run is
            // reviewable: which branch merged, where a conflict happened, errors.
            const newLogs: WtLogEntry[] = [];
            for (let i = 0; i < steps.length; i++) {
              const cur = steps[i];
              if (run.steps[i].phase !== cur.phase)
                newLogs.push({
                  at: now,
                  title: cur.title,
                  phase: cur.phase,
                  from: run.steps[i].phase,
                  stepId: cur.stepId,
                  branch: cur.branch,
                  note: cur.note,
                });
            }
            setWtRun(projectId, { ...run, steps, log: [...(run.log ?? []), ...newLogs] });
          }

          // Whole run finished cleanly → auto-merge the integration branch into
          // the current branch, then clear the run so the graph shows the tidy,
          // completed plan (completion is persisted in plan.completed).
          const allDone = steps.length > 0 && steps.every((s) => s.phase === "done");
          const anyErr = steps.some((s) => s.phase === "error");
          if (allDone && !anyErr && !wtFinal.current[projectId]) {
            wtFinal.current[projectId] = true;
            let finalNote = "";
            try {
              const res = await wtFinalize(
                run.cwd,
                run.integDir,
                run.branch,
                `Merge plan ${run.branch}`,
              );
              if (res.status === "ok")
                finalNote = `${run.branch}를 현재 브랜치에 병합했어요.`;
              else if (res.status === "restore_dirty")
                finalNote = `${run.branch}를 병합했어요. 단, 커밋 안 했던 변경을 되돌리다 충돌이 나 작업트리에 남겨뒀어요 (안전하게 git stash에도 보관됨 — 충돌 해결 후 git stash drop).`;
              else if (res.status === "conflict")
                finalNote = `최종 병합에서 충돌이 나 중단했어요 (작업트리는 원래대로 복원됨) — ${run.branch}를 직접 병합해주세요.`;
              else if (res.status === "stash_failed")
                finalNote = `작업트리 변경을 임시 보관(stash)하지 못해 병합을 건너뛰었어요 — 정리 후 ${run.branch}를 수동 병합하세요.`;
              else finalNote = `최종 병합을 건너뛰었어요 — ${run.branch}를 수동 병합하세요.`;
              const clean = res.status === "ok";
              setWtMsg((m) => ({
                ...m,
                [projectId]: clean ? `✅ 플랜 완료 · ${finalNote}` : `⚠️ 플랜 완료. 단, ${finalNote}`,
              }));
              // A stuck merge becomes a one-click "let Claude finish it" action.
              if (res.status !== "ok") {
                const status = res.status;
                setWtFix((m) => ({
                  ...m,
                  [projectId]: { branch: run.branch, cwd: run.cwd, status },
                }));
              }
            } catch (e) {
              finalNote = `최종 병합 실패: ${String(e)}`;
              setWtMsg((m) => ({ ...m, [projectId]: finalNote }));
            }
            // Archive the finished run (with the final event) for the log panel.
            const finished = wtRunsRef.current[projectId];
            if (finished) {
              const finalEntry: WtLogEntry = { at: now, title: "플랜 완료", phase: "final", note: finalNote };
              setWtLastRun(projectId, { ...finished, log: [...(finished.log ?? []), finalEntry] });
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

  /** Count of terminals blocked on a permission prompt, per project — the rail
   *  shows this as a badge and the window title sums it. */
  const waitingByProject = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of config.terminals) {
      if (statuses[t.id] === "waiting") m[t.projectId] = (m[t.projectId] ?? 0) + 1;
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
    waitingByProject,
    activity,
    jumpToTerm,
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
    setGlobalPresets,
    addPreset,
    updatePreset,
    removePreset,
    setPresetBody,
    runPreset,
    generatePresetBody,
    presetGen,
    toasts,
    dismissToast,
    addWebTab,
    removeWebTab,
    renameWebTab,
    openTab,
    openAllWebTabs,
    sendToWebTab,
    broadcastToWebTabs,
    artifacts,
    openArtifact,
    clearArtifacts,
    planning,
    requestPlan,
    loadPlan,
    runSteps,
    stopBoardRun,
    toggleCollapsed,
    addTheme,
    addFeature,
    addStep,
    renameNode,
    editStep,
    removePlanNode,
    setStepDeps,
    setStepFeature,
    wtRuns,
    wtLastRun,
    clearWtLastRun,
    wtMsg,
    wtFix,
    resolveFinalize,
    setPlanCardScale,
    setPlanView,
    setPlanFocus,
    setPlanDir,
    setPlanSort,
    stopWtRun,
    clearWtMsg,
    showWtStep,
    removePlan,
    resume,
    deleteSession,
  };
}
