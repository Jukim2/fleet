//! Resolved paths + hook status for the settings/diagnostics panel.
use serde::Serialize;
use tauri::AppHandle;

use crate::bridge::{hook_is_installed, HOOK_PORT};
use crate::config::config_path;
use crate::home_dir;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    version: String,
    home: String,
    config_path: String,
    claude_projects_dir: String,
    hook_port: u16,
    hook_installed: bool,
}

/// Resolved paths + hook status, for the settings/diagnostics panel.
#[tauri::command]
pub fn app_diagnostics(app: AppHandle) -> Diagnostics {
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
pub fn path_exists(path: String) -> bool {
    !path.is_empty() && std::path::Path::new(&path).exists()
}

/// Reveal a path in the OS file manager.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
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
