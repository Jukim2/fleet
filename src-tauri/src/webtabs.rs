//! Logged-in AI sites (ChatGPT / Claude.ai / Gemini / ...) opened as their own
//! native webview windows — NOT iframes, since those sites block framing. Each
//! window shares the app's persistent data dir, so a one-time login sticks
//! across restarts (subscription session reused, no API billing). To "send a
//! prompt" the frontend evaluates a per-site injector JS in the window, so one
//! broadcast can hit many tabs.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// A real desktop-browser User-Agent. The default embedded-webview UA (which
/// carries a WebView2/wry token) gets flagged by bot protection (e.g. ChatGPT's
/// Cloudflare), leaving a blank, stuck page. Pretending to be normal Chrome/
/// Safari lets these sites render.
#[cfg(target_os = "windows")]
const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[cfg(target_os = "macos")]
const WEB_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
#[cfg(all(unix, not(target_os = "macos")))]
const WEB_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Filesystem-safe folder name for a profile key (tab ids are already uuid-ish,
/// but sanitize defensively).
#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Deterministic 16-byte data-store id for a profile (macOS/iOS session
/// isolation, where `data_directory` isn't available on WKWebView).
#[cfg(target_os = "macos")]
fn profile_uuid(profile: &str) -> [u8; 16] {
    use std::hash::{Hash, Hasher};
    let mut out = [0u8; 16];
    for salt in 0u8..2 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        salt.hash(&mut h);
        profile.hash(&mut h);
        let v = h.finish().to_le_bytes();
        let base = salt as usize * 8;
        out[base..base + 8].copy_from_slice(&v);
    }
    out
}

/// Open (or focus, if already open) a web tab pointing at `url`. `profile` keys
/// an isolated login session (one per tab → same site, multiple accounts).
#[tauri::command]
pub fn open_web_tab(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
    profile: String,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("bad url '{url}': {e}"))?;
    let title = if title.is_empty() { "Fleet · Web" } else { &title };
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(title)
        .user_agent(WEB_UA)
        .inner_size(980.0, 860.0);
    // Per-tab session isolation: each profile gets its own cookie jar, so the
    // same site can be logged into different accounts in different tabs.
    #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
    {
        if let Ok(base) = app.path().app_config_dir() {
            let dir = base.join("web-profiles").join(sanitize(&profile));
            std::fs::create_dir_all(&dir).ok();
            builder = builder.data_directory(dir);
        }
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(profile_uuid(&profile));
    }
    // Intercept the site's own downloads (e.g. the GPT image "download" button)
    // and redirect them into Fleet's artifacts dir, announcing each finished file
    // as a `web-artifact` event the frontend collects into its inbox.
    let art_dir = app.path().app_config_dir().ok().map(|b| b.join("artifacts"));
    if let Some(d) = &art_dir {
        std::fs::create_dir_all(d).ok();
    }
    {
        use tauri::webview::DownloadEvent;
        let app = app.clone();
        let tab_label = label.clone();
        let art_dir = art_dir.clone();
        // Remember the redirected path so we can report it even on macOS, where
        // the `Finished` event carries no path.
        let last: std::sync::Arc<std::sync::Mutex<Option<std::path::PathBuf>>> =
            std::sync::Arc::new(std::sync::Mutex::new(None));
        builder = builder.on_download(move |_wv, ev| {
            match ev {
                DownloadEvent::Requested { url, destination } => {
                    if let Some(dir) = &art_dir {
                        let name = destination
                            .file_name()
                            .map(|f| f.to_string_lossy().to_string())
                            .filter(|s| !s.is_empty())
                            .or_else(|| {
                                url.path_segments()
                                    .and_then(|s| s.last())
                                    .map(|s| s.to_string())
                                    .filter(|s| !s.is_empty())
                            })
                            .unwrap_or_else(|| "download".to_string());
                        let target = dir.join(name);
                        *destination = target.clone();
                        *last.lock().unwrap() = Some(target);
                    }
                    true
                }
                DownloadEvent::Finished { url, path, success } => {
                    if success {
                        let saved = path
                            .or_else(|| last.lock().unwrap().clone())
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_default();
                        let _ = app.emit(
                            "web-artifact",
                            serde_json::json!({ "tab": tab_label, "path": saved, "url": url.to_string() }),
                        );
                    }
                    true
                }
                _ => true,
            }
        });
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Evaluate JS in a web tab and return its (JSON-serialized) result — read-back
/// from the page, e.g. to detect a freshly generated image URL. Blocks up to 5s.
#[tauri::command]
pub fn web_eval_cb(app: AppHandle, label: String, js: String) -> Result<String, String> {
    let win = app.get_webview_window(&label).ok_or("web tab not open")?;
    let (tx, rx) = std::sync::mpsc::channel();
    win.eval_with_callback(&js, move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "eval timeout".to_string())
}

/// Run JS in a web tab (the frontend passes a per-site prompt injector).
#[tauri::command]
pub fn web_eval(app: AppHandle, label: String, js: String) -> Result<(), String> {
    let win = app.get_webview_window(&label).ok_or("web tab not open")?;
    win.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_web_tab(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.close();
    }
    Ok(())
}

/// Whether a web tab window currently exists (open).
#[tauri::command]
pub fn web_tab_open(app: AppHandle, label: String) -> bool {
    app.get_webview_window(&label).is_some()
}
