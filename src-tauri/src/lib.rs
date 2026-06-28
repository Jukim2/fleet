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
    // Tag the PTY so Claude Code hooks fired inside it can report which terminal
    // they belong to (the hook command echoes $FLEET_TERM_ID back to our server).
    cmd.env("FLEET_TERM_ID", &id);

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

/// The user's home directory, cross-platform. Windows native processes often
/// have no `HOME` (only `USERPROFILE`), so fall back to that.
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|s| !s.is_empty())
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
    let home = match home_dir() {
        Some(h) => h,
        None => return vec![],
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

// --- Claude Code hook bridge ---------------------------------------------
//
// Instead of screen-scraping the terminal to guess busy/idle, we let Claude
// Code's own lifecycle hooks tell us. Each PTY is tagged with FLEET_TERM_ID;
// the installed hook command POSTs the hook's JSON payload to this local
// server with `?term=<FLEET_TERM_ID>`, and we re-emit it to the frontend as a
// `hook-event` so the UI can update status and raise notifications.

/// Localhost port the hook bridge listens on. Baked into the installed hook
/// command, so it must stay in sync with `HOOK_CMD`.
const HOOK_PORT: u16 = 47100;

/// The shell command Fleet installs into ~/.claude/settings.json. It streams
/// the hook's stdin JSON to our server, tagged with this PTY's id. Kept short
/// and non-blocking (-m 2, `|| true`) so it can never stall a Claude turn.
/// POSIX `sh` syntax works on all platforms: Claude Code runs shell-form
/// command hooks via `sh -c` on macOS/Linux and Git Bash on Windows, and
/// `curl` ships with modern Windows 10/11. Any command containing
/// `FLEET_TERM_ID` is treated as ours (for idempotent re-install).
const HOOK_CMD: &str = "curl -s -m 2 -X POST \"http://127.0.0.1:47100/hook?term=$FLEET_TERM_ID\" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    term_id: String,
    event: String,
    notification_type: String,
}

fn start_hook_server(app: AppHandle) {
    let listener = match std::net::TcpListener::bind(("127.0.0.1", HOOK_PORT)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[fleet] hook server bind failed on {HOOK_PORT}: {e}");
            return;
        }
    };
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            thread::spawn(move || handle_hook_conn(stream, &app));
        }
    });
}

fn handle_hook_conn(mut stream: std::net::TcpStream, app: &AppHandle) {
    use std::io::{BufRead, BufReader, Read, Write};
    let peek = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(peek);

    // Request line, e.g. "POST /hook?term=abc HTTP/1.1"
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let term_id = path
        .split_once('?')
        .and_then(|(_, q)| q.split('&').find_map(|kv| kv.strip_prefix("term=")))
        .unwrap_or("")
        .to_string();

    // Headers — we only need Content-Length.
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            break;
        }
        let t = line.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some(v) = t.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }

    let mut body = vec![0u8; content_length];
    let _ = reader.read_exact(&mut body);

    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let _ = stream.flush();

    if term_id.is_empty() {
        return; // not a Fleet-spawned session
    }
    let (event, notification_type) = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => (
            v.get("hook_event_name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            v.get("notification_type").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        ),
        Err(_) => (String::new(), String::new()),
    };
    let _ = app.emit(
        "hook-event",
        HookEvent { term_id, event, notification_type },
    );
}

/// True if a settings.json hook group was installed by us (its command echoes
/// FLEET_TERM_ID), so re-install can replace it cleanly.
fn group_is_ours(g: &serde_json::Value) -> bool {
    g.get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains("FLEET_TERM_ID"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Merge Fleet's lifecycle hooks into ~/.claude/settings.json without touching
/// the user's existing hooks. Idempotent: prior Fleet groups are replaced.
#[tauri::command]
fn ensure_hook_installed() -> Result<(), String> {
    let home = home_dir().ok_or_else(|| "no home dir".to_string())?;
    let dir = std::path::Path::new(&home).join(".claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.json");

    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let hooks_v = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks_v.is_object() {
        *hooks_v = serde_json::json!({});
    }
    let hooks = hooks_v.as_object_mut().unwrap();

    let group = |matcher: Option<&str>| -> serde_json::Value {
        let mut g = serde_json::Map::new();
        if let Some(m) = matcher {
            g.insert("matcher".into(), serde_json::json!(m));
        }
        g.insert(
            "hooks".into(),
            serde_json::json!([{ "type": "command", "command": HOOK_CMD }]),
        );
        serde_json::Value::Object(g)
    };
    let install = |hooks: &mut serde_json::Map<String, serde_json::Value>,
                   event: &str,
                   groups: Vec<serde_json::Value>| {
        let arr_v = hooks.entry(event).or_insert_with(|| serde_json::json!([]));
        if !arr_v.is_array() {
            *arr_v = serde_json::json!([]);
        }
        let arr = arr_v.as_array_mut().unwrap();
        arr.retain(|g| !group_is_ours(g));
        arr.extend(groups);
    };

    install(hooks, "Stop", vec![group(None)]);
    install(hooks, "UserPromptSubmit", vec![group(None)]);
    install(
        hooks,
        "Notification",
        vec![group(Some("permission_prompt")), group(Some("idle_prompt"))],
    );

    let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

// --- Diagnostics (settings panel) ----------------------------------------

/// True if Fleet's hooks are present in ~/.claude/settings.json.
fn hook_is_installed() -> bool {
    let home = match home_dir() {
        Some(h) => h,
        None => return false,
    };
    let path = std::path::Path::new(&home).join(".claude").join("settings.json");
    std::fs::read_to_string(&path)
        .map(|c| c.contains("FLEET_TERM_ID"))
        .unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    version: String,
    home: String,
    config_path: String,
    claude_projects_dir: String,
    hook_port: u16,
    hook_installed: bool,
}

/// Resolved paths + hook status, for the settings/diagnostics panel.
#[tauri::command]
fn app_diagnostics(app: AppHandle) -> Diagnostics {
    let version = app.package_info().version.to_string();
    let home = home_dir().unwrap_or_default();
    let config_path = config_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let claude_projects_dir = if home.is_empty() {
        String::new()
    } else {
        std::path::Path::new(&home)
            .join(".claude")
            .join("projects")
            .to_string_lossy()
            .to_string()
    };
    Diagnostics {
        version,
        home,
        config_path,
        claude_projects_dir,
        hook_port: HOOK_PORT,
        hook_installed: hook_is_installed(),
    }
}

/// Does this path still exist on disk? Used to flag stale project folders.
#[tauri::command]
fn path_exists(path: String) -> bool {
    !path.is_empty() && std::path::Path::new(&path).exists()
}

/// Reveal a path in the OS file manager.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let prog = "xdg-open";
    std::process::Command::new(prog)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Sessions::default())
        .setup(|app| {
            start_hook_server(app.handle().clone());
            Ok(())
        })
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
            ensure_hook_installed,
            app_diagnostics,
            path_exists,
            open_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
