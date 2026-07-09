// The coding-agent abstraction, manifest-driven.
//
// Fleet drives an interactive agent CLI in each PTY. Rather than hardcoding each
// agent (claude, codex, …) in code, an agent is DESCRIBED by a data manifest
// (`fleet-agent.json` shape, see `AgentManifest`): its binary, how flags map for
// auto/accept/effort, how a session resumes, how its status is detected, and
// where its past sessions live. `compileAgent()` turns a manifest into an
// `AgentSpec` (the runtime surface the rest of the app consumes); built-ins
// (claude, codex) are just manifests that ship with the app. Adding a new agent
// = dropping in a manifest — no code change, no rebuild.
//
// The active agent is a single global setting (`FleetConfig.agent` = an agent
// id). A terminal's concrete `startup` string still records which CLI it
// launched, so `agentOf()` can recover the right spec for any existing terminal
// even after the global setting changes.
//
// Status detection is the one part that isn't pure data: a manifest SELECTS one
// of a small, fixed set of strategies Fleet implements —
//   - "hooks":   Claude Code lifecycle hooks (settings.json + FLEET_TERM_ID).
//   - "rollout": tail the agent's structured session log (jsonl) and map its
//                events to busy/idle/waiting. Language- and TUI-agnostic.
//   - "screen":  scan the xterm viewport with regexes (fragile fallback).

/** An agent id (built-in "claude"/"codex", or a custom manifest's id). */
export type AgentKind = string;

/** Reasoning effort passed to a freshly-spawned session. Agents that don't
 *  support the full range remap via the manifest's `effortMap` (e.g. codex maps
 *  xhigh/max → high). No effort → inherit the CLI's own default. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** How a terminal's live status is determined. */
export type StatusMode = "hooks" | "rollout" | "screen";
/** How the resume list discovers this agent's past sessions. */
export type SessionMode = "claude" | "codex" | "none";

/** Options for building a startup command line. */
export type StartupOpts = {
  /** hands-free: skip every approval/permission prompt */
  auto?: boolean;
  /** accept-edits: write files without a prompt, but not run arbitrary commands
   *  unattended (used by the planner/preset generators) */
  accept?: boolean;
  /** reasoning effort; omitted → CLI default */
  effort?: Effort;
};

/**
 * The data description of an agent CLI — the `fleet-agent.json` shape. Only
 * `id`, `label`, `bin` are required; everything else has sensible defaults
 * derived from a `claude`-like CLI.
 */
export type AgentManifest = {
  /** globally-unique id (lowercase/digits/hyphen) */
  id: string;
  /** display name + default terminal-title base */
  label: string;
  /** the binary typed into the shell (first word of the launch command) */
  bin: string;
  /** flag fragments appended for each mode. `effort` is a template with `{v}`. */
  flags?: { auto?: string; accept?: string; effort?: string };
  /** optional per-effort value remap (e.g. { xhigh: "high", max: "high" }) */
  effortMap?: Partial<Record<Effort, string>>;
  /** resume command template with `{id}` (default `<bin> --resume {id}`) */
  resume?: string;
  /** regex (one capture group) extracting the resume id from a startup string */
  resumeIdRe?: string;
  /** regex (global) removing the existing resume clause when rewriting to resume */
  resumeStripRe?: string;
  /** status-detection strategy + its parameters */
  status?: {
    mode: StatusMode;
    /** screen mode: regex text meaning "a turn is running" */
    busy?: string;
    /** screen mode: regex text meaning "blocked on an approval prompt" */
    waiting?: string;
    /** rollout mode: session-log dir (default resolved by the backend, e.g.
     *  ~/.codex/sessions). */
    rolloutDir?: string;
  };
  /** resume-list discovery strategy (default "none") */
  sessions?: SessionMode;
};

export type AgentSpec = {
  id: string;
  /** alias of `id`, kept for call sites that switch on the agent "kind" */
  kind: string;
  label: string;
  bin: string;
  statusMode: StatusMode;
  sessionMode: SessionMode;
  /** rollout mode only: the session-log dir override ("" → backend default) */
  rolloutDir: string;
  /** screen mode only: "a turn is running" / "blocked on approval" patterns */
  screenBusyRe?: RegExp;
  screenWaitingRe?: RegExp;
  /** build the startup command line for a fresh session */
  startup: (opts?: StartupOpts) => string;
  /** build the command line that resumes session `id` */
  resume: (id: string, opts?: StartupOpts) => string;
  /** rewrite an existing `startup` to resume `id`, preserving its flags. A
   *  non-matching startup (e.g. a plain shell) is returned unchanged. */
  toResume: (startup: string, id: string) => string;
  /** does `startup` launch THIS agent? */
  matches: (startup: string) => boolean;
  /** the resume/session id baked into `startup`, if any */
  resumeIdOf: (startup: string) => string | null;
  /** the raw manifest this spec was compiled from */
  manifest: AgentManifest;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compile a manifest into the runtime spec the app consumes. */
export function compileAgent(m: AgentManifest): AgentSpec {
  const bin = m.bin.trim();
  const binWord = bin.split(/\s+/)[0];
  const flags = m.flags ?? {};
  const resumeTpl = m.resume ?? `${bin} --resume {id}`;
  const matchRe = new RegExp(`^\\s*${escapeRe(binWord)}(\\s|$)`);
  const idRe = new RegExp(m.resumeIdRe ?? `(?:--resume|-r)(?:=|\\s+)(\\S+)`);
  const stripRe = new RegExp(m.resumeStripRe ?? `(?:--resume|-r)(?:=|\\s+)\\S+`, "g");

  const effortValue = (e: Effort) => m.effortMap?.[e] ?? e;
  const appendFlags = (cmd: string, o?: StartupOpts) => {
    if (o?.auto && flags.auto) cmd += ` ${flags.auto}`;
    else if (o?.accept && flags.accept) cmd += ` ${flags.accept}`;
    if (o?.effort && flags.effort) cmd += ` ${flags.effort.replace("{v}", effortValue(o.effort))}`;
    return cmd;
  };

  const status = m.status ?? { mode: "hooks" as StatusMode };
  const spec: AgentSpec = {
    id: m.id,
    kind: m.id,
    label: m.label,
    bin,
    statusMode: status.mode,
    sessionMode: m.sessions ?? "none",
    rolloutDir: status.rolloutDir ?? "",
    screenBusyRe: status.busy ? new RegExp(status.busy, "i") : undefined,
    screenWaitingRe: status.waiting ? new RegExp(status.waiting, "i") : undefined,
    startup: (o) => appendFlags(bin, o),
    resume: (id, o) => appendFlags(resumeTpl.replace("{id}", id), o),
    matches: (s) => matchRe.test(s),
    resumeIdOf: (s) => {
      const v = idRe.exec(s)?.[1];
      return v && !v.startsWith("-") ? v : null;
    },
    toResume: (startup, id) => {
      if (!matchRe.test(startup)) return startup;
      const rest = startup
        .trim()
        .replace(new RegExp(`^\\s*${escapeRe(binWord)}\\b`), "")
        .replace(stripRe, "")
        .replace(/\s+/g, " ")
        .trim();
      return resumeTpl.replace("{id}", id) + (rest ? ` ${rest}` : "");
    },
    manifest: m,
  };
  return spec;
}

// --- Built-in agent manifests ----------------------------------------------

export const BUILTIN_AGENT_MANIFESTS: AgentManifest[] = [
  {
    id: "claude",
    label: "Claude",
    bin: "claude",
    flags: {
      auto: "--dangerously-skip-permissions",
      accept: "--permission-mode acceptEdits",
      effort: "--effort {v}",
    },
    resume: "claude --resume {id}",
    // Claude Code's own lifecycle hooks authoritatively drive status.
    status: { mode: "hooks" },
    sessions: "claude",
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    flags: {
      auto: "--dangerously-bypass-approvals-and-sandbox",
      accept: "--full-auto",
      effort: "-c model_reasoning_effort={v}",
    },
    // Codex reasoning effort tops out at "high".
    effortMap: { xhigh: "high", max: "high" },
    resume: "codex resume {id}",
    // `codex resume <uuid>` (skip the `--last` form, which has no explicit id).
    resumeIdRe: "\\bresume\\s+(?!--last\\b)([^\\s-]\\S*)",
    resumeStripRe: "\\bresume(?:\\s+[^\\s-]\\S*)?|--last",
    // Codex has no Claude-style hooks; instead Fleet tails the session's rollout
    // log (structured events), which is language- and TUI-version independent.
    // The busy/waiting regexes are a screen-scan FALLBACK used only until the
    // rollout watcher binds (or if it can't) — verified against codex.exe.
    status: {
      mode: "rollout",
      busy: "esc to interrupt",
      waiting:
        "allow codex to (?:run|apply)|allow this action|do you want to (?:approve|allow|run|download)|yes, and allow",
    },
    sessions: "codex",
  },
];

// --- Registry (built-ins merged with user manifests) ------------------------

let REGISTRY: Record<string, AgentSpec> = {};

/** Parse + validate a raw `fleet-agent.json` blob. Throws a Korean message on
 *  the first problem (surfaced to the user in the settings connect flow). */
export function parseAgentManifest(raw: unknown): AgentManifest {
  if (!raw || typeof raw !== "object") throw new Error("fleet-agent.json이 객체가 아니에요.");
  const o = raw as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const id = str("id");
  if (!/^[a-z0-9-]+$/.test(id))
    throw new Error("id는 소문자·숫자·하이픈만 쓸 수 있어요 (예: gemini).");
  const label = str("label");
  if (!label) throw new Error("label(표시명)이 필요해요.");
  const bin = str("bin");
  if (!bin) throw new Error("bin(실행 명령)이 필요해요.");
  const status = o.status as AgentManifest["status"] | undefined;
  if (status && !["hooks", "rollout", "screen"].includes(status.mode))
    throw new Error('status.mode는 "hooks" | "rollout" | "screen" 중 하나여야 해요.');
  if (status?.mode === "screen" && !status.busy)
    throw new Error('status.mode "screen"에는 busy 정규식이 필요해요.');
  // Validate any regexes early so a bad pattern fails here, not at runtime.
  for (const [k, v] of [
    ["resumeIdRe", o.resumeIdRe],
    ["resumeStripRe", o.resumeStripRe],
    ["status.busy", status?.busy],
    ["status.waiting", status?.waiting],
  ] as const) {
    if (typeof v === "string" && v)
      try {
        new RegExp(v);
      } catch {
        throw new Error(`${k} 정규식이 올바르지 않아요: ${v}`);
      }
  }
  return {
    id,
    label,
    bin,
    flags: o.flags as AgentManifest["flags"],
    effortMap: o.effortMap as AgentManifest["effortMap"],
    resume: str("resume") || undefined,
    resumeIdRe: str("resumeIdRe") || undefined,
    resumeStripRe: str("resumeStripRe") || undefined,
    status,
    sessions: o.sessions as SessionMode | undefined,
  };
}

/** Compile built-ins + user manifests into a spec registry (custom wins on id). */
export function mergeAgentManifests(custom?: Record<string, unknown>): Record<string, AgentSpec> {
  const out: Record<string, AgentSpec> = {};
  for (const m of BUILTIN_AGENT_MANIFESTS) out[m.id] = compileAgent(m);
  for (const raw of Object.values(custom ?? {})) {
    try {
      const m = parseAgentManifest(raw);
      out[m.id] = compileAgent(m);
    } catch (e) {
      console.warn("[fleet] skipping invalid agent manifest:", e);
    }
  }
  return out;
}

/** Install a fresh registry (called on load + whenever customAgents change).
 *  Returns the new registry. */
export function installAgents(custom?: Record<string, unknown>): Record<string, AgentSpec> {
  REGISTRY = mergeAgentManifests(custom);
  return REGISTRY;
}

// Seed the registry with built-ins at module load, so lookups work before the
// config (and its customAgents) have loaded.
installAgents();

/** Look up a spec by id, defaulting to Claude for unknown ids. */
export const getAgent = (id: string | undefined): AgentSpec => REGISTRY[id ?? "claude"] ?? REGISTRY.claude;

/** The active agent's spec (alias of getAgent, named for its call sites). */
export const activeAgent = (id: AgentKind | undefined): AgentSpec => getAgent(id);

/** All registered agent ids / specs (built-in + custom). */
export const agentIds = (): string[] => Object.keys(REGISTRY);
export const allAgents = (): AgentSpec[] => Object.values(REGISTRY);

/** Recover the spec for a concrete terminal `startup` command, across all
 *  registered agents. Plain shells (and anything unrecognized) fall back to
 *  Claude so behavior is unchanged for them. */
export function agentOf(startup: string): AgentSpec {
  for (const spec of Object.values(REGISTRY)) {
    if (spec.id !== "claude" && spec.matches(startup)) return spec;
  }
  return REGISTRY.claude;
}

/** Regex matching an auto-generated default terminal title ("Claude", "Codex 2",
 *  "Gemini") — such titles are eligible to be replaced by a session's first
 *  prompt. Built from every registered agent's label. */
export function defaultTitleRe(): RegExp {
  const labels = allAgents()
    .map((a) => escapeRe(a.label))
    .join("|");
  return new RegExp(`^(?:${labels})(\\s*\\d+)?$`, "i");
}

/** True if `startup` launches any known coding agent (vs a plain shell). */
export const isAgentStartup = (startup: string): boolean =>
  Object.values(REGISTRY).some((s) => s.matches(startup));
