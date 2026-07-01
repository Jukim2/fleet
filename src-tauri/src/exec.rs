//! One-shot shell command execution for "code" presets.
//!
//! Code presets (e.g. "open Xcode", "boot the simulator") run a single shell
//! command in the project's cwd and report only success/failure — they do NOT
//! go through a PTY or touch the interactive `claude` session. This is meant for
//! fire-and-forget launchers that return promptly; long-running commands (dev
//! servers, watchers) belong in a real terminal pane, not here.
use std::process::Command;

/// Run `command` through the platform shell in `cwd`. Returns stdout on success,
/// or the trimmed stderr (falling back to stdout) as the error on a non-zero exit.
///
/// `async` + `spawn_blocking` is load-bearing: a plain sync `#[tauri::command]`
/// runs on the main thread, so the blocking `output()` (which waits for the child
/// to exit AND its pipes to close) would freeze the whole app. Running it on a
/// blocking worker keeps the UI responsive while the command runs.
#[tauri::command]
pub async fn run_command(cwd: String, command: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = shell_command(&command);
        cmd.current_dir(&cwd);

        let out = cmd.output().map_err(|e| format!("명령 실행 실패: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let msg = stderr.trim();
            let msg = if msg.is_empty() { stdout.trim() } else { msg };
            let msg = if msg.is_empty() {
                format!("종료 코드 {}", out.status.code().unwrap_or(-1))
            } else {
                msg.to_string()
            };
            Err(msg)
        }
    })
    .await
    .map_err(|e| format!("명령 실행 스레드 오류: {e}"))?
}

#[cfg(target_os = "windows")]
fn shell_command(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", command]);
    // Don't flash a console window for the shell itself.
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn shell_command(command: &str) -> Command {
    // Use a login shell so PATH matches what the user gets in a normal terminal
    // (GUI-launched apps on macOS otherwise miss /usr/local/bin, Homebrew, etc.).
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = Command::new(shell);
    cmd.args(["-l", "-c", command]);
    cmd
}
