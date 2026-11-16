//! Supervises the Python FastAPI backend (spawn, logs, stop).

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::settings::Settings;
use crate::util::{no_window, path_str};

#[derive(Default)]
pub struct BackendCtl {
    pub child: Mutex<Option<Child>>,
    pub logs: StdMutex<VecDeque<String>>,
    pub external: StdMutex<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub running: bool,
    pub external: bool,
    pub pid: Option<u32>,
    pub url: String,
}

/// Location of the Python sources: FORGE3D_BACKEND_DIR (dev), else the
/// bundled resources, else ../backend next to the crate (cargo run).
pub fn backend_dir(app: &AppHandle) -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("FORGE3D_BACKEND_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("backend");
    if cfg!(debug_assertions) && dev.join("server.py").is_file() {
        // canonicalize() yields \\?\ paths on Windows, which cmd.exe and some tools reject.
        let canon = dev.canonicalize().unwrap_or(dev);
        let s = crate::util::path_str(&canon);
        return Ok(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s)));
    }
    if let Ok(res) = app.path().resource_dir() {
        let dir = res.join("backend");
        if dir.join("server.py").is_file() {
            return Ok(dir);
        }
    }
    if dev.join("server.py").is_file() {
        return Ok(dev);
    }
    Err(anyhow!("sources du backend introuvables"))
}

fn push(ctl: &BackendCtl, app: &AppHandle, line: String) {
    if let Ok(mut logs) = ctl.logs.lock() {
        logs.push_back(line.clone());
        while logs.len() > 3000 {
            logs.pop_front();
        }
    }
    let _ = app.emit("backend://log", line);
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

pub async fn status(ctl: &BackendCtl, s: &Settings) -> BackendStatus {
    let mut guard = ctl.child.lock().await;
    let mut pid = None;
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => pid = child.id(),
            _ => *guard = None,
        }
    }
    let external = pid.is_none() && *ctl.external.lock().unwrap() && port_open(s.port);
    BackendStatus {
        running: pid.is_some() || external,
        external,
        pid,
        url: format!("http://127.0.0.1:{}", s.port),
    }
}

pub async fn start(app: &AppHandle, ctl: &BackendCtl, s: &Settings) -> Result<BackendStatus> {
    {
        let mut guard = ctl.child.lock().await;
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                drop(guard);
                return Ok(status(ctl, s).await);
            }
            *guard = None;
        }
    }
    if port_open(s.port) {
        // Most likely a backend orphaned by a crashed session: ask it to exit
        // so the new one picks up the current settings.
        push(ctl, app, format!("[forge] port {} occupé : arrêt de l'ancien moteur…", s.port));
        let url = format!("http://127.0.0.1:{}/shutdown", s.port);
        let _ = reqwest::Client::new()
            .post(url)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await;
        for _ in 0..25 {
            if !port_open(s.port) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        if port_open(s.port) {
            *ctl.external.lock().unwrap() = true;
            push(ctl, app, format!("[forge] port {} toujours occupé : connexion au service existant", s.port));
            return Ok(status(ctl, s).await);
        }
    }
    *ctl.external.lock().unwrap() = false;

    let py = s.venv_python();
    if !py.is_file() {
        bail!("Runtime non installé ({} absent)", py.display());
    }
    let dir = backend_dir(app)?;
    for d in [&s.outputs_dir, &s.models_dir] {
        let _ = std::fs::create_dir_all(d);
    }
    let mut cmd = tokio::process::Command::new(&py);
    cmd.arg("-u")
        .arg(dir.join("server.py"))
        .arg("--port")
        .arg(s.port.to_string())
        .current_dir(s.repo_dir())
        .env("FORGE3D_REPO", path_str(&s.repo_dir()))
        .env("FORGE3D_HUNYUAN", &s.hunyuan_dir)
        .env("FORGE3D_MODELS", &s.models_dir)
        .env("FORGE3D_OUTPUTS", &s.outputs_dir)
        .env("FORGE3D_PROFILE", &s.vram_profile)
        .env("FORGE3D_FLASHVDM", if s.flashvdm { "1" } else { "0" })
        .env("FORGE3D_T2I", &s.t2i_model)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    let mut child = cmd.spawn()?;
    let pid = child.id();
    push(ctl, app, format!("[forge] backend lancé (pid {pid:?})"));

    for (reader, _is_err) in [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), false),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), true),
    ] {
        let Some(reader) = reader else { continue };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let state = app.state::<crate::AppState>();
                push(&state.backend, &app, line);
            }
        });
    }
    *ctl.child.lock().await = Some(child);
    let _ = app.emit("backend://status", "started");
    Ok(status(ctl, s).await)
}

pub async fn stop(app: &AppHandle, ctl: &BackendCtl) -> Result<()> {
    let mut guard = ctl.child.lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
        push(ctl, app, "[forge] backend arrêté".into());
    }
    *ctl.external.lock().unwrap() = false;
    let _ = app.emit("backend://status", "stopped");
    Ok(())
}

pub fn kill_now(ctl: &BackendCtl) {
    if let Ok(mut guard) = ctl.child.try_lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.start_kill();
        }
    }
}
