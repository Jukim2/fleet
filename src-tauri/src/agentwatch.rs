//! Structured status for "rollout"-mode agents (Codex and any custom agent that
//! writes a per-session JSONL event log).
//!
//! Codex has no Claude Code-style lifecycle hooks, and reading its TUI screen is
//! fragile (breaks on version/locale changes). Instead, each Codex session
//! writes a rollout log under `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`
//! whose lines are structured events (`task_started`, `task_complete`,
//! `*_approval_request`, `user_message`, …). When Fleet spawns a Codex terminal
//! it starts a watcher here that (1) binds the terminal to the rollout file that
//! matches its cwd and was created after spawn, then (2) tails that file and
//! re-emits each meaningful event as the SAME `hook-event` the Claude hook
//! bridge emits — so the frontend's status pipeline treats Codex exactly like
//! Claude (busy / idle / waiting, plus session id for resume and the first
//! prompt for auto-titling), with no config changes to the user's Codex.
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::home_dir;

/// Mirror of the Claude hook bridge's payload (bridge.rs `HookEvent`), so the
/// frontend `hook-event` listener handles rollout-derived events identically.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    term_id: String,
    event: String,
    notification_type: String,
    session_id: String,
    transcript_path: String,
    tool_name: String,
    tool_detail: String,
    prompt: String,
}

#[derive(Default)]
struct WatchState {
    /// term_id -> its watcher's stop flag
    stops: HashMap<String, Arc<AtomicBool>>,
    /// rollout file paths already bound to a watcher (so two Codex sessions in
    /// the same cwd don't grab the same file)
    claimed: Arc<Mutex<HashSet<String>>>,
}

#[derive(Default)]
pub struct AgentWatchers(Mutex<WatchState>);

fn default_codex_dir() -> PathBuf {
    let home = home_dir().unwrap_or_default();
    Path::new(&home).join(".codex").join("sessions")
}

/// Normalize a path for cwd comparison: lowercase, `\`→`/`, no trailing slash.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Recursively collect `*.jsonl` files under `root` with their mtime (seconds).
fn collect_jsonl(root: &Path, out: &mut Vec<(PathBuf, u64)>, budget: &mut u32) {
    if *budget == 0 {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => collect_jsonl(&path, out, budget),
            Ok(_) if path.extension().and_then(|e| e.to_str()) == Some("jsonl") => {
                let mtime = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                out.push((path, mtime));
                *budget -= 1;
            }
            _ => {}
        }
    }
}

/// The `cwd` recorded in a rollout's first `session_meta` line, if any.
fn rollout_cwd(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    // The session_meta record is the first line; scan a few in case of a
    // leading blank/comment line.
    for _ in 0..5 {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim_end()) {
            if v.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                return v
                    .pointer("/payload/cwd")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    None
}

/// Find the newest unclaimed rollout in `dir` whose cwd matches `target` and was
/// last modified at/after `since_secs` (with a small margin for clock skew).
fn find_rollout(dir: &Path, target: &str, since_secs: u64, claimed: &Arc<Mutex<HashSet<String>>>) -> Option<PathBuf> {
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    let mut budget: u32 = 2000;
    collect_jsonl(dir, &mut files, &mut budget);
    files.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
    let floor = since_secs.saturating_sub(3);
    let taken = claimed.lock().unwrap();
    for (path, mtime) in files {
        if mtime < floor {
            break; // older than spawn — and everything after is older too
        }
        let key = path.to_string_lossy().to_string();
        if taken.contains(&key) {
            continue;
        }
        if rollout_cwd(&path).map(|c| norm_path(&c)) == Some(target.to_string()) {
            return Some(path);
        }
    }
    None
}

/// Map one rollout line to a `hook-event` and emit it. Only status-relevant
/// records produce an event; the rest (agent_message, token_count, …) are skipped.
fn handle_line(app: &AppHandle, term_id: &str, line: &str) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let mut ev = HookEvent {
        term_id: term_id.to_string(),
        ..Default::default()
    };
    match ty {
        "session_meta" => {
            // Persist the session id so a Fleet restart can `codex resume <id>`.
            let sid = v
                .pointer("/payload/session_id")
                .or_else(|| v.pointer("/payload/id"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            if sid.is_empty() {
                return;
            }
            ev.event = "SessionMeta".into();
            ev.session_id = sid.to_string();
        }
        "event_msg" => {
            let pt = v.pointer("/payload/type").and_then(|t| t.as_str()).unwrap_or("");
            match pt {
                "user_message" => {
                    ev.event = "UserPromptSubmit".into();
                    ev.prompt = v
                        .pointer("/payload/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .chars()
                        .take(200)
                        .collect();
                }
                // A turn is running.
                "task_started" => ev.event = "PreToolUse".into(),
                // The turn finished → idle.
                "task_complete" | "turn_complete" => ev.event = "Stop".into(),
                // Blocked on a human approval → waiting.
                "exec_approval_request" | "apply_patch_approval_request" => {
                    ev.event = "Notification".into();
                    ev.notification_type = "permission_prompt".into();
                }
                _ => return,
            }
        }
        _ => return,
    }
    let _ = app.emit("hook-event", ev);
}

fn watch_loop(
    app: AppHandle,
    term_id: String,
    cwd: String,
    since_secs: u64,
    dir: PathBuf,
    stop: Arc<AtomicBool>,
    claimed: Arc<Mutex<HashSet<String>>>,
) {
    // Phase 1 — bind this terminal to its rollout file.
    let target = norm_path(&cwd);
    let mut bound: Option<PathBuf> = None;
    while !stop.load(Ordering::Relaxed) {
        if let Some(p) = find_rollout(&dir, &target, since_secs, &claimed) {
            claimed.lock().unwrap().insert(p.to_string_lossy().to_string());
            bound = Some(p);
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    let path = match bound {
        Some(p) => p,
        None => return,
    };
    let key = path.to_string_lossy().to_string();

    // Phase 2 — tail the file, emitting events for each newly-appended line.
    let mut offset: u64 = 0;
    while !stop.load(Ordering::Relaxed) {
        if let Ok(mut f) = std::fs::File::open(&path) {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            if len > offset {
                if f.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut reader = BufReader::new(f);
                    loop {
                        let mut line = String::new();
                        let n = match reader.read_line(&mut line) {
                            Ok(n) => n,
                            Err(_) => break,
                        };
                        if n == 0 {
                            break; // EOF
                        }
                        if line.ends_with('\n') {
                            offset += n as u64;
                            handle_line(&app, &term_id, line.trim_end());
                        } else {
                            break; // partial trailing line — re-read it next tick
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(300));
    }
    claimed.lock().unwrap().remove(&key);
}

/// Start watching the rollout log for a freshly-spawned agent terminal. `since_ms`
/// is the spawn time (epoch ms) so we bind the file the session is about to
/// create, not a stale one. `dir` overrides the default `~/.codex/sessions`.
#[tauri::command]
pub fn watch_agent_session(
    app: AppHandle,
    watchers: State<AgentWatchers>,
    term_id: String,
    cwd: String,
    since_ms: u64,
    dir: Option<String>,
) -> Result<(), String> {
    let claimed = {
        let mut st = watchers.0.lock().unwrap();
        if st.stops.contains_key(&term_id) {
            return Ok(()); // already watching
        }
        let stop = Arc::new(AtomicBool::new(false));
        st.stops.insert(term_id.clone(), stop.clone());
        let claimed = st.claimed.clone();
        // Move `stop` out for the thread below.
        drop(st);
        let dir = dir
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_codex_dir);
        let app2 = app.clone();
        let claimed2 = claimed.clone();
        thread::spawn(move || {
            watch_loop(app2, term_id, cwd, since_ms / 1000, dir, stop, claimed2);
        });
        claimed
    };
    let _ = claimed;
    Ok(())
}

/// Stop watching a terminal's rollout log (called when the terminal closes).
#[tauri::command]
pub fn unwatch_agent_session(watchers: State<AgentWatchers>, term_id: String) {
    let mut st = watchers.0.lock().unwrap();
    if let Some(stop) = st.stops.remove(&term_id) {
        stop.store(true, Ordering::Relaxed);
    }
}

/// Read an agent folder's `fleet-agent.json` (the manifest; validation happens
/// on the frontend). Errors are user-showable Korean.
#[tauri::command]
pub fn read_agent_manifest(root: String) -> Result<String, String> {
    let p = Path::new(&root).join("fleet-agent.json");
    std::fs::read_to_string(&p).map_err(|e| {
        format!("fleet-agent.json을 읽을 수 없어요 ({e}) — 이 폴더에 매니페스트가 있는지 확인하세요")
    })
}
