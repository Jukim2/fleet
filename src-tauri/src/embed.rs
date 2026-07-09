//! In-window web panes — embedding a web AI (ChatGPT / Gemini / …) as a CHILD
//! webview positioned over a region of the main window, instead of a separate
//! window (webtabs.rs). Uses Tauri's multi-webview support (the `unstable`
//! feature). Those sites block `<iframe>` embedding (X-Frame-Options), so a real
//! child webview is the only way to show them inside one window.
//!
//! Tradeoff: a child webview is a native surface that always paints ABOVE the
//! main webview's DOM, so the frontend must hide it (`embed_web_show(false)`)
//! whenever an overlay (settings, palette, drawer…) should appear on top.
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl};

/// A real desktop-browser User-Agent so bot protection (ChatGPT's Cloudflare)
/// doesn't flag the embedded-webview UA and leave a blank page.
#[cfg(target_os = "windows")]
const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[cfg(target_os = "macos")]
const WEB_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
#[cfg(all(unix, not(target_os = "macos")))]
const WEB_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

fn logical_pos(x: f64, y: f64) -> Position {
    Position::Logical(LogicalPosition::new(x, y))
}
fn logical_size(w: f64, h: f64) -> Size {
    Size::Logical(LogicalSize::new(w.max(1.0), h.max(1.0)))
}

/// Move a webview far off-screen and shrink it to 1×1. A native child webview
/// always paints ABOVE the DOM and — on Windows WebView2 — `hide()`/`close()`
/// don't reliably tear the surface down; a lingering surface keeps intercepting
/// clicks over its old rect, which silently breaks every button under it (the
/// "웹 모드 들어갔다 나오면 다 고장" bug). Parking it off-screen guarantees that
/// even an un-hidable / un-closable leftover surface can never cover anything.
fn park_offscreen<R: tauri::Runtime>(wv: &tauri::Webview<R>) {
    let _ = wv.set_size(logical_size(1.0, 1.0));
    let _ = wv.set_position(logical_pos(-20000.0, -20000.0));
}

/// Create (or reposition, if it already exists) an embedded web pane `label`
/// inside the main window at the given logical rect (CSS px, window-relative).
//
// NOTE: this command is `async` on purpose. Tauri runs sync commands on the
// main (UI) thread; creating a child webview via `add_child` there DEADLOCKS —
// the call blocks the very event loop the webview creation must pump, so it
// never returns and the whole app freezes (the "웹 모드 들어가면 다 고장" bug).
// An async command runs on a worker thread, so `add_child` can dispatch to the
// UI thread and pump normally — the same way `webtabs::open_web_tab`'s
// `WebviewWindowBuilder::build()` works.
#[tauri::command]
pub async fn embed_web_create(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    profile: String,
) -> Result<(), String> {
    // Already embedded → just move/resize + ensure visible.
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.set_position(logical_pos(x, y));
        let _ = wv.set_size(logical_size(w, h));
        let _ = wv.show();
        return Ok(());
    }
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("bad url '{url}': {e}"))?;
    let window = app.get_window("main").ok_or("main window not found")?;
    #[allow(unused_mut)]
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed)).user_agent(WEB_UA);
    // Persist + isolate the login session (shared key with the separate-window
    // web tabs so a one-time login carries over).
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
        let _ = &profile; // data_store isolation differs on WKWebView; skip for the prototype
    }
    window
        .add_child(builder, logical_pos(x, y), logical_size(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Move/resize an existing embedded pane to a new logical rect.
#[tauri::command]
pub fn embed_web_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let wv = app.get_webview(&label).ok_or("embed pane not found")?;
    wv.set_position(logical_pos(x, y)).map_err(|e| e.to_string())?;
    wv.set_size(logical_size(w, h)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Show or hide an embedded pane (hidden while an overlay is on top of it).
#[tauri::command]
pub fn embed_web_show(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        if visible {
            let _ = wv.show();
        } else {
            // Hide AND park off-screen: hide() alone can leave a click-eating
            // surface behind on Windows. The frontend re-pushes real bounds on
            // the next show (it resets its cached rect while hidden).
            let _ = wv.hide();
            park_offscreen(&wv);
        }
    }
    Ok(())
}

/// Destroy an embedded pane.
#[tauri::command]
pub fn embed_web_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label) {
        // Park it off-screen first so that even if close() fails to tear the
        // native surface down, nothing is left covering the window.
        let _ = wv.hide();
        park_offscreen(&wv);
        let _ = wv.close();
    }
    Ok(())
}
