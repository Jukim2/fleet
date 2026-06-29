// Thin wrappers over the Rust git worktree commands (see src-tauri/src/git.rs).
import { invoke } from "@tauri-apps/api/core";

export const gitIsRepo = (cwd: string) => invoke<boolean>("git_is_repo", { cwd });

export const wtSetup = (cwd: string, integDir: string, branch: string) =>
  invoke<void>("wt_setup", { cwd, integDir, branch });

export const wtAdd = (cwd: string, dir: string, branch: string, base: string) =>
  invoke<void>("wt_add", { cwd, dir, branch, base });

/** Returns true if something was committed, false if the worktree had no changes. */
export const wtCommit = (dir: string, message: string) =>
  invoke<boolean>("wt_commit", { dir, message });

export const wtMerge = (integDir: string, branch: string, message: string) =>
  invoke<{ status: "ok" | "conflict" }>("wt_merge", { integDir, branch, message });

export const wtHasConflicts = (integDir: string) =>
  invoke<boolean>("wt_has_conflicts", { integDir });

export const wtMergeContinue = (integDir: string) =>
  invoke<void>("wt_merge_continue", { integDir });

export const wtRemove = (cwd: string, dir: string) => invoke<void>("wt_remove", { cwd, dir });

export const wtFinalize = (cwd: string, integDir: string, branch: string, message: string) =>
  invoke<{ status: "ok" | "dirty" | "conflict" }>("wt_finalize", { cwd, integDir, branch, message });
