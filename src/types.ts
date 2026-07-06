// Data model for Fleet. Persisted via the Rust load/save_config commands.

/** A project = a folder. Holds one or more terminals. */
export type Project = {
  id: string;
  name: string;
  path: string;
};

/** A terminal tab inside a project. `startup` is typed into the shell on spawn. */
export type Terminal = {
  id: string;
  projectId: string;
  title: string;
  /** "" = plain shell, "claude" = new claude, "claude --resume <id>" = resume */
  startup: string;
  /** working directory; defaults to the project path. Worktree-run sessions set
   *  this to their git worktree directory. */
  cwd?: string;
  /** true once the user renames it manually — blocks session auto-titling */
  renamed?: boolean;
};

/** A reusable prompt block. */
export type Block = { id: string; name: string; text: string };

/** A one-click action. Presets are **global** — every project shares the same
 *  name / kind / description — but the actual **body that runs is per-project**
 *  and is generated (usually by AI) separately in each project from `desc`.
 *  - "code": runs a shell command once in the project cwd (fire-and-forget
 *    launcher), reporting only success/failure — never touches the claude session.
 *  - "ai":   sends a prompt to the focused terminal's claude session.
 *  A preset itself carries no body; see `PresetBody` (per project). */
export type Preset = {
  id: string;
  name: string;
  kind: "code" | "ai";
  /** natural-language description of what this preset does. Shared across all
   *  projects; each project's executable body is AI-generated from this. */
  desc: string;
};

/** A project's executable body for a global preset. There is no global default:
 *  every project generates (or types) its own. `command` for "code" presets,
 *  `prompt` for "ai" presets. Absent = not created yet for this project. */
export type PresetBody = { command?: string; prompt?: string };

/** A logged-in web AI site (ChatGPT / Claude.ai / Gemini / ...) opened as its
 *  own native webview window and driven via JS injection. */
export type WebTab = { id: string; name: string; url: string };

/** A file harvested from a web tab (e.g. a GPT-generated image saved via the
 *  download interceptor). Non-persisted live state; the file lives on disk. */
export type WebArtifact = {
  id: string;
  /** the web tab that produced it */
  tabId: string;
  /** filename on disk */
  name: string;
  /** absolute path where it was saved */
  path: string;
  /** original in-page source URL, if known */
  url?: string;
  createdAt: number;
};

/**
 * A plan is ONE persistent, evolving graph per project — not a per-request list.
 * Three levels: theme (큰 주제, e.g. "UI 개선") → feature (기능) → step (단계).
 * New requests are decomposed and MERGED into this graph: matching themes are
 * extended, new ones appended. Steps are the executable units; a step's `prompt`
 * is what a Claude session receives, and `deps` are other step ids that must
 * finish first (cross-feature allowed).
 */
export type PlanTheme = { id: string; title: string };
export type PlanFeature = { id: string; themeId: string; title: string };
export type PlanStep = {
  id: string;
  featureId: string;
  title: string;
  /** the instruction a Claude session is given to perform this step */
  prompt: string;
  /** other step ids that must finish first */
  deps: string[];
};
export type Plan = {
  themes: PlanTheme[];
  features: PlanFeature[];
  steps: PlanStep[];
  /** per-node (theme/feature id) UI collapse state; absent → auto (collapse when done) */
  collapsed?: Record<string, boolean>;
  /** step ids that have finished — persisted so completion accumulates in the
   *  graph across runs/restarts (live `taskStatus` is in-memory only) */
  completed?: Record<string, true>;
};

/**
 * One task on a project's queue board.
 * A task belongs to a lane (`laneTermId` = the terminal that runs it) and may
 * depend on other tasks (`deps`): it won't start until every dep is `done`.
 * Tasks with no deps in different lanes run in parallel; a dep chain across
 * lanes makes them sequential.
 */
export type QueueTask = {
  id: string;
  /** the lane (track) this task runs in — references `Lane.id` */
  laneId: string;
  text: string;
  deps: string[];
};

/** How a lane gets its session: an existing terminal, or a freshly spawned one. */
export type LaneTarget =
  | { kind: "session"; termId: string }
  | { kind: "spawn"; startup: string }; // "claude" | "" (shell) | "claude --resume <id>"

/**
 * A lane (track) on the board. Unlike before, a lane is not necessarily an
 * existing terminal — a `spawn` lane creates its session when first run, and
 * remembers it in `boundTermId`. `session` lanes are tied to an existing terminal.
 */
export type Lane = {
  id: string;
  title: string;
  target: LaneTarget;
  /** the live terminal this lane runs in (spawn lanes fill this on first run) */
  boundTermId?: string;
};

/** Per-project queue board: ordered lanes (tracks) + their tasks. */
export type QueueBoard = {
  /** when true, the runner auto-dispatches eligible tasks */
  running: boolean;
  /** lanes/tracks in display order */
  lanes: Lane[];
  /** all tasks; a lane's order = this array's order filtered by laneId */
  tasks: QueueTask[];
};

/** Live run state of a board task (absent = pending). */
export type TaskStatus = "running" | "done";

/** Recursive split layout. A leaf shows one terminal; a split holds two children. */
export type Leaf = { kind: "leaf"; id: string; termId: string | null };
export type Split = {
  kind: "split";
  id: string;
  dir: "row" | "col"; // row = side by side, col = stacked
  ratio: number; // size fraction of child `a` (0..1)
  a: LayoutNode;
  b: LayoutNode;
};
export type LayoutNode = Leaf | Split;

export type FleetConfig = {
  projects: Project[];
  terminals: Terminal[];
  /** projectId -> split layout root (null = no panes shown) */
  layouts: Record<string, LayoutNode | null>;
  blocks: Block[];
  /** global one-click action presets (code launchers + ai prompts), shown in
   *  every project. Bodies live per-project in `presetBodies`. */
  presets: Preset[];
  /** projectId -> (presetId -> that project's executable body) */
  presetBodies: Record<string, Record<string, PresetBody>>;
  /** projectId -> queue board */
  boards: Record<string, QueueBoard>;
  /** logged-in web AI sites you can broadcast prompts to */
  webTabs: WebTab[];
  /** projectId -> auto-generated plan */
  plans: Record<string, Plan>;
  /** plan-graph step card size multiplier (1 = default); persisted */
  planCardScale?: number;
  /** per-project plan-graph viewport (pan + zoom), so it survives reopen */
  planViews?: Record<string, PlanViewport>;
  /** per-project focused blocks: 대블럭/중블럭 ids whose subtrees are shown
   *  together (absent or empty = 전체 보기, the whole graph) */
  planFocus?: Record<string, string[]>;
  /** plan-graph flow direction: "LR" | "RL" | "TB" | "BT" (default LR) */
  planDir?: PlanDir;
  /** plan-graph sibling ordering: "added" | "title" (default added) */
  planSort?: PlanSort;
};

/** Saved plan-graph viewport: translate (x,y) + zoom (k). */
export type PlanViewport = { x: number; y: number; k: number };

/**
 * Plan-graph layout mode. Single-direction flows: LR/RL/TB/BT. Two-sided +
 * radial spreads: H2 (좌우 양쪽), V2 (상하 양쪽), RAD (사방), GRID (대블럭 격자).
 */
export type PlanDir = "LR" | "RL" | "TB" | "BT" | "H2" | "V2" | "RAD" | "GRID";
/** Sibling ordering within a parent block. */
export type PlanSort = "added" | "title";

/** A transient corner notification (preset run result, etc.). When `action` is
 *  set the toast is clickable and jumps to that terminal (cross-project). */
export type Toast = {
  id: string;
  kind: "ok" | "err" | "info";
  text: string;
  action?: { projectId: string; termId: string };
};

/** Live, non-persisted status of a terminal.
 *  "waiting" = Claude is blocked on a permission/input prompt (needs you). */
export type TermStatus = "stopped" | "busy" | "idle" | "waiting";

/** A past claude session discoverable for resume. */
export type ClaudeSession = {
  id: string;
  summary: string;
  modified: number; // unix seconds
  /** model id from the first assistant turn (e.g. "claude-opus-4-8"), if known */
  model?: string | null;
};

export const emptyConfig: FleetConfig = {
  projects: [],
  terminals: [],
  layouts: {},
  blocks: [],
  presets: [],
  presetBodies: {},
  boards: {},
  webTabs: [],
  plans: {},
  planCardScale: 1,
};
