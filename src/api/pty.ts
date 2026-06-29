// Wrappers over the Rust PTY commands.
import { invoke } from "@tauri-apps/api/core";

export const spawnSession = (
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  startupCmd?: string,
) => invoke<void>("spawn_session", { id, cwd, cols, rows, startupCmd });

export const writePty = (id: string, data: string) =>
  invoke<void>("write_pty", { id, data });

export const sendPrompt = (id: string, text: string) =>
  invoke<void>("send_prompt", { id, text });

export const resizePty = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_pty", { id, cols, rows });

export const killSession = (id: string) => invoke<void>("kill_session", { id });

/** Install Fleet's Claude Code lifecycle hooks into ~/.claude/settings.json. */
export const ensureHookInstalled = () => invoke<void>("ensure_hook_installed");

/** Payload re-emitted by the Rust hook bridge for each Claude Code hook fire. */
export type HookEvent = {
  termId: string;
  event: string;
  notificationType: string;
  sessionId: string;
  transcriptPath: string;
};
