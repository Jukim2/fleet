// Fleet — manage multiple interactive `claude` sessions, one PTY per project.
//
// The backend is a thin PTY + filesystem service, split by concern:
//   pty         — PTY-backed terminal sessions (spawn/write/resize/kill)
//   sessions    — Claude transcript discovery for the resume list
//   config      — fleet.json persistence
//   bridge      — localhost hook/web-poll server + hook install
//   webtabs     — logged-in AI sites as native webview windows
//   cdp         — driving a real Chrome over the DevTools Protocol
//   diagnostics — settings-panel diagnostics
//
// Shared state (`pty::Sessions`, `bridge::WebQueue`) is managed in `run()`;
// each Tauri command lives in its concern's module and is registered below.
mod agentwatch;
mod attach;
mod bridge;
mod cdp;
mod config;
mod diagnostics;
mod embed;
mod exec;
mod git;
mod pty;
mod sessions;
mod tools;
mod webtabs;

/// The user's home directory, cross-platform. Windows native processes often
/// have no `HOME` (only `USERPROFILE`), so fall back to that. Shared by the
/// session-discovery, bridge, and diagnostics modules.
pub(crate) fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|s| !s.is_empty())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::Sessions::default())
        .manage(bridge::WebQueue::default())
        .manage(tools::ToolJobs::default())
        .manage(agentwatch::AgentWatchers::default())
        .setup(|app| {
            bridge::start_hook_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_session,
            pty::write_pty,
            pty::send_prompt,
            pty::resize_pty,
            pty::kill_session,
            pty::list_sessions,
            attach::save_attachment,
            attach::clipboard_paths,
            sessions::list_claude_sessions,
            sessions::delete_claude_session,
            sessions::import_session_transcript,
            agentwatch::watch_agent_session,
            agentwatch::unwatch_agent_session,
            agentwatch::read_agent_manifest,
            config::load_config,
            config::save_config,
            config::read_plan,
            config::clear_plan,
            config::read_preset,
            config::clear_preset,
            bridge::ensure_hook_installed,
            bridge::prepare_claude_auto,
            bridge::web_enqueue,
            diagnostics::app_diagnostics,
            diagnostics::path_exists,
            diagnostics::open_path,
            exec::run_command,
            tools::spawn_tool_job,
            tools::kill_tool_job,
            tools::list_tool_outputs,
            tools::import_tool_files,
            tools::read_tool_manifest,
            webtabs::open_web_tab,
            webtabs::web_eval,
            webtabs::web_eval_cb,
            webtabs::close_web_tab,
            webtabs::web_tab_open,
            embed::embed_web_create,
            embed::embed_web_bounds,
            embed::embed_web_show,
            embed::embed_web_close,
            cdp::cdp_open,
            cdp::cdp_targets,
            cdp::cdp_eval,
            git::git_is_repo,
            git::wt_setup,
            git::wt_add,
            git::wt_commit,
            git::wt_merge,
            git::wt_has_conflicts,
            git::wt_merge_continue,
            git::wt_remove,
            git::wt_finalize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
