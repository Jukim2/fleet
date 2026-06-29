//! PTY-backed terminal sessions — one live shell per project terminal.
//!
//! `spawn_session` opens a `portable-pty` PTY in the project's cwd running the
//! default shell, then optionally types a startup command (e.g. `claude`) into
//! it. A reader thread streams PTY bytes to the frontend via `pty-output` and
//! emits `pty-exit` on close. The shell — not a direct `claude` spawn — is the
//! PTY's process, so the terminal survives `claude` exiting.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// A live PTY-backed terminal session for one project.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

/// Spawn the user's default shell in `cwd`, wired to a PTY of size cols x rows.
/// Output is streamed to the frontend via the `pty-output` event; when the
/// shell exits we emit `pty-exit`. The frontend starts `claude` by writing to
/// the session (so the terminal survives claude exiting).
#[tauri::command]
pub fn spawn_session(
    app: AppHandle,
    sessions: State<Sessions>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    startup_cmd: Option<String>,
) -> Result<(), String> {
    {
        // Already running? Ignore.
        let map = sessions.0.lock().unwrap();
        if map.contains_key(&id) {
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    // Tag the PTY so Claude Code hooks fired inside it can report which terminal
    // they belong to (the hook command echoes $FLEET_TERM_ID back to our server).
    cmd.env("FLEET_TERM_ID", &id);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Reader thread: pump PTY output to the frontend.
    let app_for_thread = app.clone();
    let id_for_thread = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 65536];
        // Carry incomplete trailing bytes across reads: claude's TUI emits many
        // multi-byte glyphs (box-drawing, emoji) and a read boundary can split
        // one mid-sequence. Decoding each chunk independently would turn the
        // split bytes into replacement chars (visible screen corruption), so we
        // only emit the valid UTF-8 prefix and keep the remainder for next read.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid_up_to = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    // A UTF-8 char is at most 4 bytes. If more than that trails
                    // the valid prefix the bytes are genuinely invalid, not a
                    // split char — flush them lossily so we never get stuck.
                    let emit_up_to = if pending.len() - valid_up_to > 3 {
                        pending.len()
                    } else {
                        valid_up_to
                    };
                    if emit_up_to > 0 {
                        let data = String::from_utf8_lossy(&pending[..emit_up_to]).to_string();
                        let _ = app_for_thread.emit(
                            "pty-output",
                            PtyOutput {
                                id: id_for_thread.clone(),
                                data,
                            },
                        );
                        pending.drain(..emit_up_to);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_for_thread.emit("pty-exit", id_for_thread.clone());
    });

    let mut session = Session {
        master: pair.master,
        writer,
        child,
    };

    // Optional command to run on startup (e.g. "claude").
    if let Some(line) = startup_cmd {
        if !line.is_empty() {
            let _ = session.writer.write_all(format!("{line}\r").as_bytes());
            let _ = session.writer.flush();
        }
    }

    sessions.0.lock().unwrap().insert(id, session);
    Ok(())
}

/// Write raw bytes (keystrokes or an injected prompt) to a session.
#[tauri::command]
pub fn write_pty(sessions: State<Sessions>, id: String, data: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("no such session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Inject a prompt line and submit it (used by blocks / queue).
#[tauri::command]
pub fn send_prompt(sessions: State<Sessions>, id: String, text: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    let session = map.get_mut(&id).ok_or("no such session")?;
    // claude's TUI submits on carriage return.
    let payload = format!("{text}\r");
    session
        .writer
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    sessions: State<Sessions>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = sessions.0.lock().unwrap();
    if let Some(session) = map.get(&id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn kill_session(sessions: State<Sessions>, id: String) -> Result<(), String> {
    let mut map = sessions.0.lock().unwrap();
    if let Some(mut session) = map.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn list_sessions(sessions: State<Sessions>) -> Vec<String> {
    sessions.0.lock().unwrap().keys().cloned().collect()
}
