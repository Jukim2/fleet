// Discovery of past Claude sessions for the resume list.
import { invoke } from "@tauri-apps/api/core";
import { ClaudeSession } from "../types";

export const listClaudeSessions = (cwd: string) =>
  invoke<ClaudeSession[]>("list_claude_sessions", { cwd });

/** Delete a transcript so it no longer appears in the resume list. */
export const deleteClaudeSession = (cwd: string, id: string) =>
  invoke<void>("delete_claude_session", { cwd, id });
