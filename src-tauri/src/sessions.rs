//! Claude session discovery for the resume list.
//!
//! Claude Code stores transcripts under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
//! We read each transcript's first real user message (the summary) plus the model
//! of its first assistant turn, streaming line-by-line so a multi-MB transcript
//! never has to be loaded whole.
use serde::Serialize;

use crate::home_dir;

#[derive(Serialize)]
pub struct ClaudeSession {
    id: String,
    summary: String,
    /// seconds since UNIX epoch (file mtime)
    modified: u64,
    /// model id from the first assistant turn, if found near the top (e.g.
    /// "claude-opus-4-8"). None when not seen within the scan window.
    model: Option<String>,
}

/// Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
/// where the cwd is encoded by replacing every character that isn't ASCII
/// alphanumeric or `-` with `-` (per-character). This covers `/` and `.` on
/// macOS/Linux as well as `\`, `:`, and spaces on Windows.
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect()
}

fn extract_user_text(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let is_user = v.get("type").and_then(|t| t.as_str()) == Some("user")
        || v.pointer("/message/role").and_then(|r| r.as_str()) == Some("user");
    if !is_user {
        return None;
    }
    let msg = v.pointer("/message/content");
    let text = match msg {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(arr)) => arr.iter().find_map(|item| {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
            } else {
                None
            }
        }),
        _ => None,
    };
    let t = text?;
    let t = t.trim();
    if !t.is_empty() && !t.starts_with('<') {
        Some(t.chars().take(90).collect())
    } else {
        None
    }
}

/// Pull the model id out of an assistant transcript line (`message.model`).
fn extract_model(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let is_assistant = v.get("type").and_then(|t| t.as_str()) == Some("assistant")
        || v.pointer("/message/role").and_then(|r| r.as_str()) == Some("assistant");
    if !is_assistant {
        return None;
    }
    v.pointer("/message/model")
        .and_then(|m| m.as_str())
        .filter(|s| !s.is_empty() && *s != "<synthetic>")
        .map(|s| s.to_string())
}

/// Read the first real user message (the summary) and the first assistant
/// model from a transcript without loading the whole file. Transcripts can be
/// tens of MB each (full tool-output history), but both live near the top — so
/// we stream line-by-line and stop once we have both. Bounded so a pathological
/// file can't stall the scan.
fn scan_transcript(path: &std::path::Path) -> (Option<String>, Option<String>) {
    use std::io::{BufRead, BufReader};
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut scanned = 0usize;
    let mut summary: Option<String> = None;
    let mut model: Option<String> = None;
    while scanned < 400 {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break,
        }
        scanned += 1;
        let trimmed = line.trim_end();
        if summary.is_none() {
            summary = extract_user_text(trimmed);
        }
        if model.is_none() {
            model = extract_model(trimmed);
        }
        if summary.is_some() && model.is_some() {
            break;
        }
    }
    (summary, model)
}

#[tauri::command]
pub fn list_claude_sessions(cwd: String, agent: Option<String>) -> Vec<ClaudeSession> {
    // `agent` is the active agent's session-discovery mode ("claude" | "codex" |
    // "none"). Unknown/absent falls back to Claude for backward compatibility.
    match agent.as_deref() {
        Some("codex") => return list_codex_sessions(&cwd),
        Some("none") => return vec![],
        _ => {}
    }
    let home = match home_dir() {
        Some(h) => h,
        None => return vec![],
    };
    // Resolve the project's transcript dir by matching the encoded name
    // case-insensitively — Windows has a known drive-letter casing bug where the
    // folder is created as `C--…` but looked up as `c--…`.
    let projects_dir = std::path::Path::new(&home).join(".claude").join("projects");
    let encoded = encode_project_dir(&cwd);
    let dir = match std::fs::read_dir(&projects_dir) {
        Ok(entries) => entries
            .flatten()
            .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&encoded))
            .map(|e| e.path()),
        Err(_) => None,
    };
    let dir = match dir {
        Some(d) => d,
        None => return vec![],
    };

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    let mut sessions: Vec<ClaudeSession> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let modified = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let (summary, model) = scan_transcript(&path);
        let summary = summary.unwrap_or_else(|| "(빈 세션)".to_string());
        sessions.push(ClaudeSession { id, summary, modified, model });
    }

    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    sessions
}

/// Copy a transcript produced in a worktree step into the project's own Claude
/// session folder, so a plan run's work shows up in the project's resume list and
/// can be continued from the project root (the step's changes are already merged
/// in). `transcript_path` is the absolute `.jsonl` reported by the step's hook.
/// Returns the session id (file stem) on success. No-op-safe if already imported.
#[tauri::command]
pub fn import_session_transcript(project_path: String, transcript_path: String) -> Result<String, String> {
    let src = std::path::Path::new(&transcript_path);
    let id = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("bad transcript path")?
        .to_string();
    if !src.exists() {
        return Err("transcript not found".into());
    }
    let home = home_dir().ok_or("no home dir")?;
    let projects_dir = std::path::Path::new(&home).join(".claude").join("projects");
    let encoded = encode_project_dir(&project_path);
    // Reuse the project's existing transcript folder (case-insensitive match for
    // the Windows drive-letter casing quirk); else create it under the encoded name.
    let dir = std::fs::read_dir(&projects_dir)
        .ok()
        .and_then(|entries| {
            entries
                .flatten()
                .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&encoded))
                .map(|e| e.path())
        })
        .unwrap_or_else(|| projects_dir.join(&encoded));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{id}.jsonl"));
    if dest.exists() {
        return Ok(id); // already imported
    }
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Delete a single transcript (`<id>.jsonl`) from the project's Claude folder.
/// `id` is validated as a bare uuid-style stem so a crafted value can't escape
/// the directory.
#[tauri::command]
pub fn delete_claude_session(cwd: String, id: String, agent: Option<String>) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid session id".into());
    }
    if agent.as_deref() == Some("codex") {
        return delete_codex_session(&id);
    }
    let home = home_dir().ok_or("no home dir")?;
    let projects_dir = std::path::Path::new(&home).join(".claude").join("projects");
    let encoded = encode_project_dir(&cwd);
    let dir = std::fs::read_dir(&projects_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&encoded))
        .map(|e| e.path())
        .ok_or("project transcript folder not found")?;
    let path = dir.join(format!("{id}.jsonl"));
    if !path.exists() {
        return Ok(()); // already gone — treat as success
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

// --- Codex session discovery -----------------------------------------------
//
// Codex CLI stores each interactive session as
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<session_id>.jsonl
// The first line is a `session_meta` record carrying the session's `cwd` and
// `session_id`; a later `event_msg`/`user_message` holds the first prompt, and a
// `turn_context` holds the model. Unlike Claude (one folder per project), every
// project's sessions live in one dated tree, so we walk it and filter by cwd.

/// Normalize a path for cwd comparison: lowercase, `\`→`/`, no trailing slash.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Recursively collect `*.jsonl` files under `root` (bounded so a huge history
/// can't stall the scan). Returns (path, mtime-seconds).
fn collect_jsonl(root: &std::path::Path, out: &mut Vec<(std::path::PathBuf, u64)>, budget: &mut u32) {
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
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect_jsonl(&path, out, budget);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
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
    }
}

/// Pull the first real user prompt out of a codex rollout line.
fn extract_codex_user_text(v: &serde_json::Value) -> Option<String> {
    let payload = v.get("payload")?;
    // Preferred: an explicit user_message event.
    let text = if payload.get("type").and_then(|t| t.as_str()) == Some("user_message") {
        payload.get("message").and_then(|m| m.as_str()).map(|s| s.to_string())
    } else if payload.get("type").and_then(|t| t.as_str()) == Some("message")
        && payload.get("role").and_then(|r| r.as_str()) == Some("user")
    {
        // Fallback: a user response_item's first input_text block.
        payload
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| {
                arr.iter().find_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("input_text") {
                        item.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
            })
    } else {
        None
    };
    let t = text?;
    let t = t.trim();
    // Skip the synthetic environment_context / instruction blocks (they open `<`).
    if !t.is_empty() && !t.starts_with('<') {
        Some(t.chars().take(90).collect())
    } else {
        None
    }
}

/// Scan a codex rollout: (cwd, session_id, summary, model). Reads only the top
/// of the file — session_meta is line 1 and the first prompt/model are near it.
fn scan_codex_rollout(
    path: &std::path::Path,
) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    use std::io::{BufRead, BufReader};
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None, None, None),
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut scanned = 0usize;
    let (mut cwd, mut sid, mut summary, mut model) = (None, None, None, None);
    while scanned < 200 {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        scanned += 1;
        let v: serde_json::Value = match serde_json::from_str(line.trim_end()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if ty == "session_meta" {
            if let Some(p) = v.get("payload") {
                if cwd.is_none() {
                    cwd = p.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string());
                }
                if sid.is_none() {
                    sid = p
                        .get("session_id")
                        .or_else(|| p.get("id"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                }
            }
        } else if ty == "turn_context" && model.is_none() {
            model = v
                .pointer("/payload/model")
                .and_then(|m| m.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
        }
        if summary.is_none() {
            summary = extract_codex_user_text(&v);
        }
        if cwd.is_some() && sid.is_some() && summary.is_some() && model.is_some() {
            break;
        }
    }
    (cwd, sid, summary, model)
}

fn codex_sessions_dir() -> Option<std::path::PathBuf> {
    let home = home_dir()?;
    Some(std::path::Path::new(&home).join(".codex").join("sessions"))
}

fn list_codex_sessions(cwd: &str) -> Vec<ClaudeSession> {
    let dir = match codex_sessions_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let mut files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    let mut budget: u32 = 4000; // cap files touched so the scan stays bounded
    collect_jsonl(&dir, &mut files, &mut budget);
    // Newest first so we scan (and keep) the most recent sessions when capped.
    files.sort_by(|a, b| b.1.cmp(&a.1));

    let target = norm_path(cwd);
    let mut sessions: Vec<ClaudeSession> = Vec::new();
    for (path, mtime) in files {
        if sessions.len() >= 200 {
            break;
        }
        let (scwd, sid, summary, model) = scan_codex_rollout(&path);
        let scwd = match scwd {
            Some(c) => c,
            None => continue,
        };
        if norm_path(&scwd) != target {
            continue;
        }
        let id = match sid {
            Some(s) => s,
            None => continue,
        };
        sessions.push(ClaudeSession {
            id,
            summary: summary.unwrap_or_else(|| "(빈 세션)".to_string()),
            modified: mtime,
            model,
        });
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    sessions
}

/// Delete a codex rollout by session id: find the `rollout-*<id>.jsonl` file in
/// the sessions tree and remove it. `id` is already validated as uuid-style.
fn delete_codex_session(id: &str) -> Result<(), String> {
    let dir = codex_sessions_dir().ok_or("no home dir")?;
    let mut files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    let mut budget: u32 = 6000;
    collect_jsonl(&dir, &mut files, &mut budget);
    for (path, _) in files {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.contains(id) {
            return std::fs::remove_file(&path).map_err(|e| e.to_string());
        }
    }
    Ok(()) // not found — treat as already gone
}
