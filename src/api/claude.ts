// Discovery of past agent sessions (Claude or Codex) for the resume list.
import { invoke } from "@tauri-apps/api/core";
import { ClaudeSession } from "../types";
import { AgentKind } from "../lib/agents";

export const listClaudeSessions = (cwd: string, agent: AgentKind = "claude") =>
  invoke<ClaudeSession[]>("list_claude_sessions", { cwd, agent });

/** Delete a transcript so it no longer appears in the resume list. */
export const deleteClaudeSession = (cwd: string, id: string, agent: AgentKind = "claude") =>
  invoke<void>("delete_claude_session", { cwd, id, agent });

/** Copy a worktree step's transcript into the project's session folder so it
 *  appears in the resume list. Returns the session id. */
export const importSessionTranscript = (projectPath: string, transcriptPath: string) =>
  invoke<string>("import_session_transcript", { projectPath, transcriptPath });
