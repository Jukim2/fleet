// One-shot shell command execution for "code" presets.
import { invoke } from "@tauri-apps/api/core";

/** Run a shell command (fire-and-forget launcher) in `cwd`.
 *  Resolves with the command's stdout on success; rejects with stderr on failure. */
export const runCommand = (cwd: string, command: string) =>
  invoke<string>("run_command", { cwd, command });
