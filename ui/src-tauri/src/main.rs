#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! WIS+ — Tauri v2 desktop shell.
//!
//! Responsibilities beyond hosting the webview:
//!   * **Sidecar lifecycle** — automatically spawn the local Python backend
//!     (`backend/main.py`, `python -m backend.main`) on startup and guarantee
//!     it is terminated when the app exits, so no orphaned uvicorn process is
//!     ever left bound to 127.0.0.1:8321.
//!   * The sidecar is located by walking up from the CWD / executable path,
//!     which works both in `tauri dev` (CWD = ui/) and in packaged builds
//!     where a repo checkout sits next to the install tree.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent};

/// App-managed state: the sidecar child process (None until spawned / after kill).
#[derive(Default)]
struct BackendState(Mutex<Option<Child>>);

/// Walk up from plausible starting points until we find a directory that looks
/// like the WIS+ repo root (has both backend/main.py and shared/schema.sql).
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

    for start in starts {
        let mut cursor: Option<&Path> = Some(start.as_path());
        while let Some(dir) = cursor {
            if dir.join("backend/main.py").is_file() && dir.join("shared/schema.sql").is_file() {
                return Some(dir.to_path_buf());
            }
            cursor = dir.parent();
        }
    }
    None
}

/// Spawn `python -m backend.main` from the project root. Windows: no console
/// window flash; Linux/Arch: python3.
fn spawn_backend(root: &Path) -> Result<Child, String> {
    let port = std::env::var("WISPLUS_PORT").unwrap_or_else(|_| "8321".to_string());

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("python");
        // CREATE_NO_WINDOW — keep the sidecar console-less on Windows.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
        c
    } else {
        Command::new("python3")
    };

    cmd.args(["-m", "backend.main"])
        .current_dir(root)
        .env("WISPLUS_PORT", port)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    cmd.spawn().map_err(|e| format!("failed to spawn backend sidecar: {e}"))
}

fn kill_backend(state: &BackendState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            match child.kill() {
                Ok(()) => eprintln!("[wis+] backend sidecar terminated (pid {})", child.id()),
                Err(e) => eprintln!("[wis+] sidecar already gone: {e}"),
            }
            // Reap the zombie; ignore errors if it already exited.
            let _ = child.wait();
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(BackendState::default())
        .setup(|app| {
            // Spawn off the main thread so window creation is never blocked by
            // Python's import time (fastembed/PyMuPDF can take a couple seconds).
            let handle = app.handle().clone();
            std::thread::spawn(move || match find_project_root() {
                Some(root) => match spawn_backend(&root) {
                    Ok(child) => {
                        eprintln!("[wis+] backend sidecar spawned (pid {}) from {}", child.id(), root.display());
                        *handle.state::<BackendState>().0.lock().unwrap() = Some(child);
                    }
                    Err(e) => eprintln!("[wis+] {e}"),
                },
                None => eprintln!(
                    "[wis+] project root not found (backend/main.py missing). \
                     Start the sidecar manually: python -m backend.main"
                ),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build WIS+ Tauri application");

    app.run(|app, event| match event {
        // Hard guarantee: the sidecar dies with the app (Windows does not
        // auto-kill orphaned children; on Linux this also frees the port).
        RunEvent::Exit => kill_backend(&app.state::<BackendState>()),
        _ => {}
    });
}
