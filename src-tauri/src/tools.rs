//! External tool runner — the "command center" backend.
//!
//! Fleet can drive sibling tools (e.g. SpriteForge's headless CLI) directly,
//! without going through a claude session: the frontend builds the argv from a
//! tool manifest, and this module spawns the process, streams its stdout/stderr
//! lines as `tool-job-output` events, and emits `tool-job-exit` when it ends.
//! It also scans a job's output folder for result images and copies selected
//! results back into a Fleet project ("← 프로젝트로 가져오기").
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Live tool processes, keyed by job id. The `AtomicBool` marks a job the user
/// killed, so its non-zero exit is reported as "killed" rather than "error".
#[derive(Default)]
pub struct ToolJobs(pub Mutex<HashMap<String, (Arc<Mutex<Child>>, Arc<AtomicBool>)>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolOutput {
    job_id: String,
    line: String,
    err: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolExit {
    job_id: String,
    code: i32,
    killed: bool,
}

/// Spawn `program args…` in `cwd` and stream its output. Returns as soon as the
/// process is running; progress arrives via events. One reader thread per pipe
/// (they must drain concurrently or the child can deadlock on a full pipe), and
/// a waiter thread reaps the exit code once both pipes hit EOF.
#[tauri::command]
pub fn spawn_tool_job(
    app: AppHandle,
    jobs: State<ToolJobs>,
    job_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<(), String> {
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{program} 실행 실패: {e} (cwd: {cwd})"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let killed = Arc::new(AtomicBool::new(false));
    jobs.0
        .lock()
        .unwrap()
        .insert(job_id.clone(), (child.clone(), killed.clone()));

    let reader = |pipe: Box<dyn std::io::Read + Send>, err: bool, app: AppHandle, job: String| {
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                let line = line.trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                let _ = app.emit("tool-job-output", ToolOutput { job_id: job.clone(), line, err });
            }
        })
    };
    let t_out = stdout.map(|p| reader(Box::new(p), false, app.clone(), job_id.clone()));
    let t_err = stderr.map(|p| reader(Box::new(p), true, app.clone(), job_id.clone()));

    // Waiter: pipes at EOF ⇒ the child is done (or dying); wait() then returns
    // promptly, so holding the child mutex here can't starve kill_tool_job.
    std::thread::spawn(move || {
        if let Some(t) = t_out {
            let _ = t.join();
        }
        if let Some(t) = t_err {
            let _ = t.join();
        }
        let code = child
            .lock()
            .unwrap()
            .wait()
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(-1);
        let was_killed = killed.load(Ordering::Relaxed);
        let _ = app.emit("tool-job-exit", ToolExit { job_id: job_id.clone(), code, killed: was_killed });
        if let Some(jobs) = app.try_state::<ToolJobs>() {
            jobs.0.lock().unwrap().remove(&job_id);
        }
    });
    Ok(())
}

/// Kill a running tool job. The exit event still fires (via the waiter thread),
/// flagged as killed.
#[tauri::command]
pub fn kill_tool_job(jobs: State<ToolJobs>, job_id: String) -> Result<(), String> {
    let entry = jobs.0.lock().unwrap().get(&job_id).cloned();
    match entry {
        Some((child, killed)) => {
            killed.store(true, Ordering::Relaxed);
            child.lock().unwrap().kill().map_err(|e| e.to_string())
        }
        None => Ok(()), // already exited
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFile {
    pub name: String,
    pub path: String,
    /// path relative to the scanned dir (keeps subfolder context, e.g. slices)
    pub rel: String,
    pub size: u64,
    pub modified_ms: u64,
}

const IMAGE_EXTS: [&str; 6] = ["png", "webp", "gif", "svg", "jpg", "jpeg"];

fn scan_outputs(dir: &std::path::Path, base: &std::path::Path, since_ms: u64, depth: u32, out: &mut Vec<ToolFile>) {
    if depth > 4 || out.len() >= 500 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_outputs(&path, base, since_ms, depth + 1, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if modified_ms < since_ms {
            continue;
        }
        out.push(ToolFile {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path.to_string_lossy().to_string(),
            rel: path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string(),
            size: meta.len(),
            modified_ms,
        });
    }
}

/// Image results under `dir` (recursive, capped) modified at/after `since_ms`
/// (0 = no filter). Feeds the result-preview grid after a tool job finishes.
#[tauri::command]
pub fn list_tool_outputs(dir: String, since_ms: u64) -> Vec<ToolFile> {
    let base = std::path::PathBuf::from(&dir);
    let mut out = Vec::new();
    scan_outputs(&base, &base, since_ms, 0, &mut out);
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// Read a tool folder's `fleet-tool.json` (the tool-integration manifest —
/// validation happens on the frontend). Errors are user-showable Korean.
#[tauri::command]
pub fn read_tool_manifest(root: String) -> Result<String, String> {
    let p = std::path::Path::new(&root).join("fleet-tool.json");
    std::fs::read_to_string(&p)
        .map_err(|e| format!("fleet-tool.json을 읽을 수 없어요 ({e}) — 이 폴더가 Fleet 툴 규격을 따르는지 확인하세요"))
}

/// Copy result files into a project folder (creating it), deduping name
/// collisions with a ` (n)` suffix. Returns the number of files copied.
#[tauri::command]
pub fn import_tool_files(paths: Vec<String>, dest: String) -> Result<u32, String> {
    let dest_dir = std::path::PathBuf::from(&dest);
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    let mut copied = 0u32;
    for p in &paths {
        let src = std::path::Path::new(p);
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        let mut target = dest_dir.join(&name);
        if target.exists() {
            let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
            for n in 1..100 {
                target = dest_dir.join(format!("{stem} ({n}){ext}"));
                if !target.exists() {
                    break;
                }
            }
        }
        std::fs::copy(src, &target).map_err(|e| format!("{name} 복사 실패: {e}"))?;
        copied += 1;
    }
    Ok(copied)
}
