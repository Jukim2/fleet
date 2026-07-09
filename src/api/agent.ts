// invoke() wrappers for the agent-manifest + rollout-status backend
// (src-tauri/src/agentwatch.rs).
import { invoke } from "@tauri-apps/api/core";

/** raw text of `<root>/fleet-agent.json` (throws if the file is missing) */
export const readAgentManifest = (root: string) =>
  invoke<string>("read_agent_manifest", { root });

/** Start tailing a "rollout"-mode agent's session log for this terminal, so its
 *  busy/idle/waiting status arrives as structured events (not screen-scraped).
 *  `sinceMs` = spawn time (Date.now()); `dir` overrides the default log dir. */
export const watchAgentSession = (termId: string, cwd: string, sinceMs: number, dir?: string) =>
  invoke<void>("watch_agent_session", { termId, cwd, sinceMs, dir });

/** Stop the rollout watcher for a terminal (on close). */
export const unwatchAgentSession = (termId: string) =>
  invoke<void>("unwatch_agent_session", { termId });
