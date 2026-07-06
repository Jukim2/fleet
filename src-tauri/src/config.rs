//! `fleet.json` persistence in the OS app-config dir. The whole `FleetConfig`
//! is stored as one JSON blob; the frontend owns its shape.
use tauri::{AppHandle, Manager};

pub(crate) fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // FLEET_CONFIG_DIR overrides the OS dir — lets a second instance run with
    // an isolated profile (demo/screenshots/dev) without touching the real one.
    let dir = match std::env::var("FLEET_CONFIG_DIR").ok().filter(|s| !s.is_empty()) {
        Some(d) => std::path::PathBuf::from(d),
        None => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
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

// --- Plan file (a project's .fleet/plan.json, written by the planner Claude) --

fn plan_path(cwd: &str) -> std::path::PathBuf {
    std::path::Path::new(cwd).join(".fleet").join("plan.json")
}

/// Read a project's plan JSON, or null if it doesn't exist yet.
#[tauri::command]
pub fn read_plan(cwd: String) -> Option<String> {
    std::fs::read_to_string(plan_path(&cwd)).ok()
}

/// Delete the plan file (called before asking the planner to regenerate, so we
/// can detect when the fresh one lands).
#[tauri::command]
pub fn clear_plan(cwd: String) -> Result<(), String> {
    let p = plan_path(&cwd);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Preset file (.fleet/preset.json, written by the AI preset generator) -----

fn preset_path(cwd: &str) -> std::path::PathBuf {
    std::path::Path::new(cwd).join(".fleet").join("preset.json")
}

/// Read the AI-generated preset JSON for a project, or null if not written yet.
#[tauri::command]
pub fn read_preset(cwd: String) -> Option<String> {
    std::fs::read_to_string(preset_path(&cwd)).ok()
}

/// Delete the preset file before asking the generator to write a fresh one, so
/// we can detect when the new one lands.
#[tauri::command]
pub fn clear_preset(cwd: String) -> Result<(), String> {
    let p = preset_path(&cwd);
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}
