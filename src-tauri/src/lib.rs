// Fleet — manage multiple interactive `claude` sessions, one PTY per project.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// A live PTY-backed terminal session for one project.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct Sessions(Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

/// Spawn the user's default shell in `cwd`, wired to a PTY of size cols x rows.
/// Output is streamed to the frontend via the `pty-output` event; when the
/// shell exits we emit `pty-exit`. The frontend starts `claude` by writing to
/// the session (so the terminal survives claude exiting).
#[tauri::command]
fn spawn_session(
    app: AppHandle,
    sessions: State<Sessions>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    startup_cmd: Option<String>,
) -> Result<(), String> {
    {
        // Already running? Ignore.
        let map = sessions.0.lock().unwrap();
        if map.contains_key(&id) {
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Reader thread: pump PTY output to the frontend.
    let app_for_thread = app.clone();
    let id_for_thread = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_thread.emit(
                        "pty-output",
                        PtyOutput {
                            id: id_for_thread.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit("pty-exit", id_for_thread.clone());
    });

    let mut session = Session {
        master: pair.master,
        writer,
        child,
    };

    // Optional command to run on startup (e.g. "claude").
    if let Some(line) = startup_cmd {
        if !line.is_empty() {
            let _ = session.writer.write_all(format!("{line}\r").as_bytes());
            let _ = session.writer.flush();
        }
    }

    sessions.0.lock().unwrap().insert(id, session);
    Ok(())
}

/// Write raw bytes (keystrokes or an injected prompt) to a session.
#[tauri::command]
fn write_pty(sessions: State<Sessions>, id: String, data: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("no such session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Inject a prompt line and submit it (used by blocks / queue).
#[tauri::command]
fn send_prompt(sessions: State<Sessions>, id: String, text: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("no such session")?;
    // claude's TUI submits on carriage return.
    let payload = format!("{text}\r");
    session
        .writer
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_pty(sessions: State<Sessions>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = sessions.0.lock().unwrap();
    if let Some(session) = map.get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn kill_session(sessions: State<Sessions>, id: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    if let Some(mut session) = map.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn list_sessions(sessions: State<Sessions>) -> Vec<String> {
    sessions.0.lock().unwrap().keys().cloned().collect()
}

// --- Claude session discovery (for resume) -------------------------------

#[derive(Serialize)]
struct ClaudeSession {
    id: String,
    summary: String,
    /// seconds since UNIX epoch (file mtime)
    modified: u64,
}

/// Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
/// where the cwd is encoded by replacing "/" and "." with "-".
fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn first_user_text(content: &str) -> Option<String> {
    for line in content.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let is_user = v.get("type").and_then(|t| t.as_str()) == Some("user")
            || v.pointer("/message/role").and_then(|r| r.as_str()) == Some("user");
        if !is_user {
            continue;
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
        if let Some(t) = text {
            let t = t.trim();
            if !t.is_empty() && !t.starts_with('<') {
                return Some(t.chars().take(90).collect());
            }
        }
    }
    None
}

#[tauri::command]
fn list_claude_sessions(cwd: String) -> Vec<ClaudeSession> {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return vec![],
    };
    let dir = std::path::Path::new(&home)
        .join(".claude")
        .join("projects")
        .join(encode_project_dir(&cwd));

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
        let summary = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| first_user_text(&c))
            .unwrap_or_else(|| "(빈 세션)".to_string());
        sessions.push(ClaudeSession { id, summary, modified });
    }

    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    sessions
}

// --- Config persistence (projects, blocks, queue) -------------

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("fleet.json"))
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<String, String> {
    let path = config_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok("null".to_string()),
    }
}

#[tauri::command]
fn save_config(app: AppHandle, data: String) -> Result<(), String> {
    let path = config_path(&app)?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            spawn_session,
            write_pty,
            send_prompt,
            resize_pty,
            kill_session,
            list_sessions,
            list_claude_sessions,
            load_config,
            save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
