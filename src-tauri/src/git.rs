//! Git worktree pipeline support.
//!
//! The plan "worktree 모드" runs each selected step in its own git worktree +
//! branch, then commits and merges it into a dedicated integration branch in
//! dependency order. These commands are thin, stateless wrappers around the
//! `git` CLI — the frontend owns the run state and computes paths/branch names.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Run git in `dir`, returning stdout on success or stderr as the error.
fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// Like `git` but never errors on a non-zero exit — returns (success, stdout, stderr).
fn git_raw(dir: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/// Is `cwd` inside a git work tree?
#[tauri::command]
pub fn git_is_repo(cwd: String) -> bool {
    git(&cwd, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// Add `.fleet/` to the repo's LOCAL excludes (.git/info/exclude) so the worktree
/// directories never show up as changes — and without touching the tracked
/// .gitignore. Idempotent.
fn ensure_ignore(cwd: &str) -> Result<(), String> {
    let common = git(cwd, &["rev-parse", "--git-common-dir"])?;
    let common = common.trim();
    let common_path = if Path::new(common).is_absolute() {
        PathBuf::from(common)
    } else {
        Path::new(cwd).join(common)
    };
    let exclude = common_path.join("info").join("exclude");
    let cur = std::fs::read_to_string(&exclude).unwrap_or_default();
    if cur
        .lines()
        .any(|l| matches!(l.trim(), ".fleet/" | ".fleet"))
    {
        return Ok(());
    }
    if let Some(parent) = exclude.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut next = cur;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(".fleet/\n");
    std::fs::write(&exclude, next).map_err(|e| e.to_string())
}

/// Create the integration worktree on a fresh `branch` from current HEAD.
#[tauri::command]
pub fn wt_setup(cwd: String, integ_dir: String, branch: String) -> Result<(), String> {
    ensure_ignore(&cwd)?;
    let (ok, _o, e) = git_raw(&cwd, &["worktree", "add", "-b", &branch, &integ_dir, "HEAD"])?;
    if ok {
        return Ok(());
    }
    // Re-run: branch already exists → just check it out into the worktree.
    let (ok2, _o2, e2) = git_raw(&cwd, &["worktree", "add", &integ_dir, &branch])?;
    if ok2 {
        Ok(())
    } else {
        Err(format!("통합 워크트리 생성 실패:\n{e}\n{e2}"))
    }
}

/// Create a step worktree at `dir` on a fresh `branch` based on `base`
/// (the integration branch tip, which already contains merged dependencies).
#[tauri::command]
pub fn wt_add(cwd: String, dir: String, branch: String, base: String) -> Result<(), String> {
    let (ok, _o, e) = git_raw(&cwd, &["worktree", "add", "-b", &branch, &dir, &base])?;
    if ok {
        return Ok(());
    }
    let (ok2, _o2, e2) = git_raw(&cwd, &["worktree", "add", &dir, &branch])?;
    if ok2 {
        Ok(())
    } else {
        Err(format!("워크트리 생성 실패:\n{e}\n{e2}"))
    }
}

/// Stage everything in a worktree and commit. Returns false if there was nothing
/// to commit (e.g. the session made no changes, or already committed itself).
#[tauri::command]
pub fn wt_commit(dir: String, message: String) -> Result<bool, String> {
    git(&dir, &["add", "-A"])?;
    // `diff --cached --quiet` exits 0 when there is nothing staged.
    let (clean, _o, _e) = git_raw(&dir, &["diff", "--cached", "--quiet"])?;
    if clean {
        return Ok(false);
    }
    git(&dir, &["commit", "-m", &message])?;
    Ok(true)
}

#[derive(Serialize)]
pub struct MergeResult {
    /// "ok" = merged cleanly, "conflict" = needs resolution
    pub status: String,
}

/// Merge `branch` into the integration worktree. Reports a conflict instead of
/// failing so the caller can drive resolution.
#[tauri::command]
pub fn wt_merge(integ_dir: String, branch: String, message: String) -> Result<MergeResult, String> {
    let (ok, _o, _e) = git_raw(&integ_dir, &["merge", "--no-ff", "-m", &message, &branch])?;
    if ok {
        return Ok(MergeResult { status: "ok".into() });
    }
    let (has_merge_head, _o2, _e2) =
        git_raw(&integ_dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?;
    if has_merge_head {
        Ok(MergeResult {
            status: "conflict".into(),
        })
    } else {
        Err(format!("병합 실패: {_e}"))
    }
}

/// Are there unresolved conflicts in the integration worktree?
#[tauri::command]
pub fn wt_has_conflicts(integ_dir: String) -> Result<bool, String> {
    let out = git(&integ_dir, &["ls-files", "-u"])?;
    Ok(!out.trim().is_empty())
}

/// Finalize an in-progress merge once conflicts are resolved. No-op if the
/// resolver session already committed the merge itself.
#[tauri::command]
pub fn wt_merge_continue(integ_dir: String) -> Result<(), String> {
    let (has_merge_head, _o, _e) =
        git_raw(&integ_dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])?;
    if has_merge_head {
        git(&integ_dir, &["add", "-A"])?;
        git(&integ_dir, &["commit", "--no-edit"])?;
    }
    Ok(())
}

/// Remove a worktree directory and prune the registry. Best-effort.
#[tauri::command]
pub fn wt_remove(cwd: String, dir: String) -> Result<(), String> {
    let _ = git_raw(&cwd, &["worktree", "remove", "--force", &dir]);
    let _ = git_raw(&cwd, &["worktree", "prune"]);
    Ok(())
}

/// Final merge: bring the integration branch into the branch currently checked
/// out in the main working tree, then clean up the integration worktree.
/// Refuses on a dirty tree and aborts on conflict so the user's checkout is
/// never left in a broken/half-merged state. Status: "ok" | "dirty" | "conflict".
#[tauri::command]
pub fn wt_finalize(
    cwd: String,
    integ_dir: String,
    branch: String,
    message: String,
) -> Result<MergeResult, String> {
    let dirty = git(&cwd, &["status", "--porcelain"])?;
    if !dirty.trim().is_empty() {
        return Ok(MergeResult {
            status: "dirty".into(),
        });
    }
    let (ok, _o, _e) = git_raw(&cwd, &["merge", "--no-ff", "-m", &message, &branch])?;
    if ok {
        let _ = git_raw(&cwd, &["worktree", "remove", "--force", &integ_dir]);
        let _ = git_raw(&cwd, &["worktree", "prune"]);
        return Ok(MergeResult { status: "ok".into() });
    }
    let _ = git_raw(&cwd, &["merge", "--abort"]);
    Ok(MergeResult {
        status: "conflict".into(),
    })
}
