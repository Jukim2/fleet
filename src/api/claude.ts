// Discovery of past Claude sessions for the resume list.
import { invoke } from "@tauri-apps/api/core";
import { ClaudeSession } from "../types";

export const listClaudeSessions = (cwd: string) =>
  invoke<ClaudeSession[]>("list_claude_sessions", { cwd });

/** Delete a transcript so it no longer appears in the resume list. */
export const deleteClaudeSession = (cwd: string, id: string) =>
  invoke<void>("delete_claude_session", { cwd, id });

/** Copy a worktree step's transcript into the project's session folder so it
 *  appears in the resume list. Returns the session id. */
export const importSessionTranscript = (projectPath: string, transcriptPath: string) =>
  invoke<string>("import_session_transcript", { projectPath, transcriptPath });
