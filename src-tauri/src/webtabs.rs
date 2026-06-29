//! Logged-in AI sites (ChatGPT / Claude.ai / Gemini / ...) opened as their own
//! native webview windows — NOT iframes, since those sites block framing. Each
//! window shares the app's persistent data dir, so a one-time login sticks
//! across restarts (subscription session reused, no API billing). To "send a
//! prompt" the frontend evaluates a per-site injector JS in the window, so one
//! broadcast can hit many tabs.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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

/// Open (or focus, if already open) a web tab pointing at `url`.
#[tauri::command]
pub fn open_web_tab(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("bad url '{url}': {e}"))?;
    let title = if title.is_empty() { "Fleet · Web" } else { &title };
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(title)
        .user_agent(WEB_UA)
        .inner_size(980.0, 860.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
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
