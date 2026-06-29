//! `fleet.json` persistence in the OS app-config dir. The whole `FleetConfig`
//! is stored as one JSON blob; the frontend owns its shape.
use tauri::{AppHandle, Manager};

pub(crate) fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("fleet.json"))
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Result<String, String> {
    let path = config_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok("null".to_string()),
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, data: String) -> Result<(), String> {
    let path = config_path(&app)?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}
