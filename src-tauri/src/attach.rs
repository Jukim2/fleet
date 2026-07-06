//! Saving pasted/dropped files to disk so they can be referenced **by path**
//! in claude's TUI — an image can't be typed into a terminal, but its path can.
//!
//! The webview never sees an OS path for these: `dragDropEnabled` is false
//! (HTML5 pane dragging needs it off), so dropped files arrive as bytes, and
//! clipboard images never had a path to begin with. The bytes come through
//! here as base64 and land in `<temp>/fleet-attach/`.

use base64::Engine;

/// Real filesystem paths currently on the OS clipboard — files/folders copied
/// in Explorer/Finder. The web paste event exposes bytes at best (a folder:
/// nothing at all), so the frontend asks here FIRST and types the real path,
/// with no temp copy. Empty when the clipboard holds no file list.
#[tauri::command]
pub fn clipboard_paths() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        use clipboard_win::{formats, get_clipboard};
        return get_clipboard::<Vec<String>, _>(formats::FileList).unwrap_or_default();
    }
    #[cfg(target_os = "macos")]
    {
        // Finder puts file URLs on the pasteboard; AppleScript reads the first
        // one (multi-item reads need ObjC — one path covers the folder case).
        let out = std::process::Command::new("osascript")
            .args(["-e", "POSIX path of (the clipboard as «class furl»)"])
            .output();
        return match out {
            Ok(o) if o.status.success() => {
                let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if p.is_empty() { Vec::new() } else { vec![p] }
            }
            _ => Vec::new(),
        };
    }
    #[allow(unreachable_code)]
    Vec::new()
}

/// Decode base64 file bytes into `<temp>/fleet-attach/<millis>-<name>` and
/// return the absolute path (what the frontend types into the PTY).
#[tauri::command]
pub fn save_attachment(name: String, data_base64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| e.to_string())?;

    let dir = std::env::temp_dir().join("fleet-attach");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Safe basename only: keep letters/digits (incl. 한글) plus . - _, cap the
    // length; the millis prefix keeps repeated names (e.g. "image.png") unique.
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .take(80)
        .collect();
    let safe = if safe.trim_matches('_').is_empty() { "file".to_string() } else { safe };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let path = dir.join(format!("{ms}-{safe}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
