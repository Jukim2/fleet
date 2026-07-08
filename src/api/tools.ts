// invoke() wrappers for the external-tool runner (src-tauri/src/tools.rs).
import { invoke } from "@tauri-apps/api/core";

/** one image/svg/gif produced by a tool job */
export type ToolFile = {
  name: string;
  path: string;
  rel: string;
  size: number;
  modifiedMs: number;
};

/** payload of the `tool-job-output` event (one stdout/stderr line) */
export type ToolJobOutput = { jobId: string; line: string; err: boolean };
/** payload of the `tool-job-exit` event */
export type ToolJobExit = { jobId: string; code: number; killed: boolean };

export const spawnToolJob = (jobId: string, program: string, args: string[], cwd: string) =>
  invoke<void>("spawn_tool_job", { jobId, program, args, cwd });

export const killToolJob = (jobId: string) => invoke<void>("kill_tool_job", { jobId });

export const listToolOutputs = (dir: string, sinceMs: number) =>
  invoke<ToolFile[]>("list_tool_outputs", { dir, sinceMs });

export const importToolFiles = (paths: string[], dest: string) =>
  invoke<number>("import_tool_files", { paths, dest });

/** raw text of `<root>/fleet-tool.json` (throws if the file is missing) */
export const readToolManifest = (root: string) =>
  invoke<string>("read_tool_manifest", { root });
