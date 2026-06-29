//! Drive a real Chrome over the DevTools Protocol for sites that won't render in
//! an embedded webview (ChatGPT/Cloudflare). We launch Chrome/Edge with remote
//! debugging on a dedicated profile, so the user logs in once and Fleet injects
//! prompts over CDP — no browser extension or userscript to install.
use serde::Serialize;
use tauri::{AppHandle, Manager};

const CDP_PORT: u16 = 9222;

/// Minimal HTTP request to Chrome's CDP HTTP endpoint (localhost). Returns body.
fn cdp_http(method: &str, path: &str) -> Result<String, String> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", CDP_PORT)).map_err(|e| e.to_string())?;
    let req =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{CDP_PORT}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf.splitn(2, "\r\n\r\n").nth(1).unwrap_or("").to_string())
}

/// Locate a Chromium-based browser executable.
fn find_chrome() -> Option<String> {
    #[cfg(target_os = "windows")]
    let candidates: Vec<String> = {
        let mut v = vec![
            r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string(),
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe".to_string(),
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe".to_string(),
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe".to_string(),
        ];
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.insert(0, format!("{local}\\Google\\Chrome\\Application\\chrome.exe"));
        }
        v
    };
    #[cfg(target_os = "macos")]
    let candidates: Vec<String> = vec![
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string(),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".to_string(),
        "/Applications/Chromium.app/Contents/MacOS/Chromium".to_string(),
    ];
    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates: Vec<String> = vec![
        "/usr/bin/google-chrome".to_string(),
        "/usr/bin/chromium".to_string(),
        "/usr/bin/chromium-browser".to_string(),
        "/usr/bin/microsoft-edge".to_string(),
    ];
    candidates
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
}

/// Launch Chrome with remote debugging (if not already up), optionally opening `url`.
fn ensure_chrome(app: &AppHandle, url: Option<&str>) -> Result<(), String> {
    // Already running? Just open a tab.
    if cdp_http("GET", "/json/version").is_ok() {
        if let Some(u) = url {
            let _ = cdp_http("PUT", &format!("/json/new?{u}"));
        }
        return Ok(());
    }
    let chrome = find_chrome().ok_or("Chrome/Edge를 찾을 수 없어요. 설치되어 있는지 확인하세요.")?;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("cdp-profile");
    std::fs::create_dir_all(&dir).ok();
    let mut cmd = std::process::Command::new(chrome);
    cmd.arg(format!("--remote-debugging-port={CDP_PORT}"));
    cmd.arg(format!("--user-data-dir={}", dir.display()));
    cmd.arg("--no-first-run");
    cmd.arg("--no-default-browser-check");
    if let Some(u) = url {
        cmd.arg(u);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cdp_open(app: AppHandle, url: String) -> Result<(), String> {
    ensure_chrome(&app, Some(&url))
}

#[derive(Serialize)]
pub struct CdpTarget {
    ws: String,
    url: String,
    title: String,
}

/// List open page tabs in the Fleet-controlled Chrome.
#[tauri::command]
pub fn cdp_targets() -> Result<Vec<CdpTarget>, String> {
    let body = cdp_http("GET", "/json")?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for t in arr {
            if t.get("type").and_then(|x| x.as_str()) != Some("page") {
                continue;
            }
            let ws = t
                .get("webSocketDebuggerUrl")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if ws.is_empty() {
                continue;
            }
            out.push(CdpTarget {
                ws,
                url: t.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                title: t.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

/// Evaluate JS in a specific tab via its CDP WebSocket (the frontend builds the
/// per-site prompt injector).
#[tauri::command]
pub fn cdp_eval(ws: String, js: String) -> Result<(), String> {
    use tungstenite::Message;
    let (mut socket, _resp) = tungstenite::connect(&ws).map_err(|e| e.to_string())?;
    let msg = serde_json::json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": { "expression": js, "awaitPromise": false, "userGesture": true }
    })
    .to_string();
    socket.send(Message::Text(msg)).map_err(|e| e.to_string())?;
    let _ = socket.read(); // best-effort: wait for the eval ack
    let _ = socket.close(None);
    Ok(())
}
