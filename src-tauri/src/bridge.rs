//! Localhost bridge on port 47100, serving two clients over one tiny HTTP server:
//!
//! 1. **Claude Code hooks** — instead of screen-scraping the terminal to guess
//!    busy/idle, we let Claude Code's own lifecycle hooks tell us. Each PTY is
//!    tagged with `FLEET_TERM_ID`; the installed hook command POSTs the hook's
//!    JSON to `/hook?term=<FLEET_TERM_ID>`, which we re-emit as a `hook-event`.
//! 2. **Web bridge queue** — embedded webviews can't drive bot-protected sites
//!    (ChatGPT/Cloudflare), so a userscript in the user's real browser long-polls
//!    `/web/poll?since=<id>` for prompts enqueued via `web_enqueue`.
//!
//! It also installs Fleet's hooks into `~/.claude/settings.json`.
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::home_dir;

/// Localhost port the hook bridge listens on. Baked into the installed hook
/// command, so it must stay in sync with `HOOK_CMD`.
pub(crate) const HOOK_PORT: u16 = 47100;

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
    /// Claude session id + transcript path from the hook payload — lets Fleet
    /// surface a worktree step's session in the project's resume list afterward.
    session_id: String,
    transcript_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebCommand {
    id: u64,
    text: String,
    /// hostnames to target (substring match); empty = all sites
    sites: Vec<String>,
}

#[derive(Default)]
pub struct WebQueue(Mutex<(u64, Vec<WebCommand>)>);

/// Enqueue a prompt for the browser userscript to pick up. Returns its id.
#[tauri::command]
pub fn web_enqueue(queue: State<WebQueue>, text: String, sites: Vec<String>) -> u64 {
    let mut q = queue.0.lock().unwrap();
    q.0 += 1;
    let id = q.0;
    q.1.push(WebCommand { id, text, sites });
    // Keep only the most recent commands so the buffer can't grow forever.
    let len = q.1.len();
    if len > 50 {
        q.1.drain(0..len - 50);
    }
    id
}

pub fn start_hook_server(app: AppHandle) {
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
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // CORS preflight (harmless; GM_xmlhttpRequest doesn't need it, plain fetch does).
    if method == "OPTIONS" {
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let _ = stream.flush();
        return;
    }

    // Browser userscript polling for prompts to inject into real tabs.
    if path.starts_with("/web/poll") {
        let since: u64 = path
            .split_once('?')
            .and_then(|(_, q)| q.split('&').find_map(|kv| kv.strip_prefix("since=")))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let state = app.state::<WebQueue>();
        let q = state.0.lock().unwrap();
        let cmds: Vec<&WebCommand> = q.1.iter().filter(|c| c.id > since).collect();
        let body = serde_json::json!({ "last": q.0, "commands": cmds }).to_string();
        drop(q);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.flush();
        return;
    }

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
    let (event, notification_type, session_id, transcript_path) =
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(v) => (
                v.get("hook_event_name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                v.get("notification_type").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                v.get("session_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                v.get("transcript_path").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            ),
            Err(_) => (String::new(), String::new(), String::new(), String::new()),
        };
    let _ = app.emit(
        "hook-event",
        HookEvent { term_id, event, notification_type, session_id, transcript_path },
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
pub fn ensure_hook_installed() -> Result<(), String> {
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

/// True if Fleet's hooks are present in ~/.claude/settings.json.
pub(crate) fn hook_is_installed() -> bool {
    let home = match home_dir() {
        Some(h) => h,
        None => return false,
    };
    let path = std::path::Path::new(&home).join(".claude").join("settings.json");
    std::fs::read_to_string(&path)
        .map(|c| c.contains("FLEET_TERM_ID"))
        .unwrap_or(false)
}
