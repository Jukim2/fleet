// Discovery of past Claude sessions for the resume list.
import { invoke } from "@tauri-apps/api/core";
import { ClaudeSession } from "../types";

export const listClaudeSessions = (cwd: string) =>
  invoke<ClaudeSession[]>("list_claude_sessions", { cwd });
