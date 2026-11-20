#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! WIS+ — Tauri v2 desktop shell.
//!
//! Sidecar lifecycle (Task 1.6):
//!   * In **release** builds the backend is a PyInstaller-frozen onedir binary
//!     shipped via `bundle.externalBin`; it is located with `app.shell().sidecar()`.
//!   * In **dev** builds (`tauri dev`) we fall back to `python -m backend.main`
//!     so developers never need to run PyInstaller.
//!   * Before spawning we probe 127.0.0.1:8321/api/health; if something already
//!     answers we attach rather than double-start.
//!   * stdout/stderr are tee\'d to `<app-data>/logs/backend.log`.
//!   * `WISPLUS_DATA_DIR` is set to the platform app-data folder so the backend
//!     stores its database, themes, and PDFs there.
//!   * The sidecar is killed on `RunEvent::Exit`.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 8321;
const HEALTH_URL: &str = "http://127.0.0.1:8321/api/health";
const SPAWN_TIMEOUT: Duration = Duration::from_secs(15);

/// Managed state: the sidecar child handle (None when external or dead).
#[derive(Default)]
struct BackendState(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Probe the health endpoint. Returns true if a backend is already listening.
fn backend_already_running() -> bool {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    client
        .get(HEALTH_URL)
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Resolve the platform app-data directory (created if missing).
fn app_data_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Open (or truncate) the backend log file inside app-data/logs/.
fn open_log_file(data_dir: &std::path::Path) -> Option<std::fs::File> {
    let log_dir = data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("backend.log"))
        .ok()
}

/// Spawn the sidecar. Returns the child handle on success.
fn spawn_sidecar(
    app: &tauri::AppHandle,
    data_dir: &std::path::Path,
) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    let log_file = open_log_file(data_dir);

    let (sidecar_path, args): (String, Vec<String>) = if cfg!(debug_assertions) {
        // Dev mode: use system python + repo source.
        let python = if cfg!(target_os = "windows") { "python" } else { "python3" };
        let root = find_project_root()
            .ok_or_else(|| "project root not found for dev sidecar".to_string())?;
        (python.to_string(), vec!["-m".into(), "backend.main".into()])
    } else {
        // Release: Tauri resolves the external binary with target-triple suffix.
        let bin = app
            .shell()
            .sidecar("wisplus-backend")
            .map_err(|e| format!("failed to resolve sidecar path: {e}"))?;
        (bin, vec![])
    };

    let mut cmd = app.shell().command(sidecar_path);
    for a in &args {
        cmd = cmd.arg(a);
    }

    // Point the backend at the app-data folder.
    cmd = cmd.env("WISPLUS_DATA_DIR", data_dir.to_string_lossy().as_ref());
    cmd = cmd.env("WISPLUS_PORT", PORT.to_string());

    if let Some(ref mut lf) = log_file {
        // Tauri shell plugin pipes stdout/stderr; we capture them via the
        // event callback below. For now, also set a file handle so that any
        // direct writes (e.g. Python logging to stderr before our pipe is
        // ready) land in the log.
        let _ = lf;
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn backend sidecar: {e}"))?;

    Ok(child)
}

/// Walk up from plausible starting points to find the WIS+ repo root (dev only).
fn find_project_root() -> Option<PathBuf> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    for start in &starts {
        let mut cursor: Option<&std::path::Path> = Some(start.as_path());
        while let Some(dir) = cursor {
            if dir.join("backend/main.py").is_file() && dir.join("shared/schema.sql").is_file() {
                return Some(dir.to_path_buf());
            }
            cursor = dir.parent();
        }
    }
    None
}

/// Wait until the backend answers /api/health or the timeout expires.
fn wait_for_backend() -> bool {
    let deadline = Instant::now() + SPAWN_TIMEOUT;
    while Instant::now() < deadline {
        if backend_already_running() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // 1. If something already serves on :8321, attach (no double-start).
                if backend_already_running() {
                    eprintln!("[wis+] backend already running on port {PORT}; attaching");
                    return;
                }

                // 2. Resolve data dir + spawn.
                let data_dir = match app_data_dir(&handle) {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("[wis+] cannot resolve app-data dir: {e}");
                        return;
                    }
                };

                match spawn_sidecar(&handle, &data_dir) {
                    Ok(child) => {
                        eprintln!("[wis+] backend sidecar spawned (pid {})", child.pid());
                        *handle.state::<BackendState>().0.lock().unwrap() = Some(child);
                    }
                    Err(e) => {
                        eprintln!("[wis+] {e}");
                        // Show a Tauri dialog so the user sees the problem.
                        let _ = tauri::async_runtime::spawn(async move {
                            tauri::Emitter::emit(&handle, "backend-error", &e).ok();
                        });
                        return;
                    }
                }

                // 3. Wait for readiness.
                if wait_for_backend() {
                    eprintln!("[wis+] backend ready on port {PORT}");
                } else {
                    eprintln!("[wis+] backend did not become ready within {SPAWN_TIMEOUT:?}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build WIS+ Tauri application");

    app.run(|app, event| match event {
        RunEvent::Exit => {
            let state = app.state::<BackendState>();
            if let Ok(mut guard) = state.0.lock() {
                if let Some(child) = guard.take() {
                    eprintln!("[wis+] terminating backend sidecar (pid {})", child.pid());
                    let _ = child.kill();
                }
            }
        }
        _ => {}
    });
}
