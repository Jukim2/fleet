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

/** Pre-clear Claude Code's first-run startup gates (folder-trust dialog for each
 *  worktree dir, plus the --dangerously-skip-permissions warning when auto) so an
 *  automated worktree session doesn't hang on a dialog the runner can't pass. */
export const prepareClaudeAuto = (dirs: string[], skipDangerous: boolean) =>
  invoke<void>("prepare_claude_auto", { dirs, skipDangerous });

/** Payload re-emitted by the Rust hook bridge for each Claude Code hook fire. */
export type HookEvent = {
  termId: string;
  event: string;
  notificationType: string;
  sessionId: string;
  transcriptPath: string;
  /** PreToolUse only: tool about to run + a short detail (file path, command…) */
  toolName: string;
  toolDetail: string;
};
