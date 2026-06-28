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
};

/** A reusable prompt block. */
export type Block = { id: string; name: string; text: string };

/**
 * One task on a project's queue board.
 * A task belongs to a lane (`laneTermId` = the terminal that runs it) and may
 * depend on other tasks (`deps`): it won't start until every dep is `done`.
 * Tasks with no deps in different lanes run in parallel; a dep chain across
 * lanes makes them sequential.
 */
export type QueueTask = {
  id: string;
  laneTermId: string;
  text: string;
  deps: string[];
};

/** Per-project queue board: ordered lanes (terminals) + their tasks. */
export type QueueBoard = {
  /** when true, the runner auto-dispatches eligible tasks */
  running: boolean;
  /** participating terminal ids, in display order (one lane each) */
  lanes: string[];
  /** all tasks; a lane's order = this array's order filtered by laneTermId */
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
  /** projectId -> queue board */
  boards: Record<string, QueueBoard>;
};

/** Live, non-persisted status of a terminal. */
export type TermStatus = "stopped" | "busy" | "idle";

/** A past claude session discoverable for resume. */
export type ClaudeSession = {
  id: string;
  summary: string;
  modified: number; // unix seconds
};

export const emptyConfig: FleetConfig = {
  projects: [],
  terminals: [],
  layouts: {},
  blocks: [],
  boards: {},
};
