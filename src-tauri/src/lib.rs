mod backend;
mod runtime;
mod settings;
mod system;
mod util;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

use settings::Settings;

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub runtime: Arc<runtime::RuntimeCtl>,
    pub backend: backend::BackendCtl,
}

impl AppState {
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    let normalized = settings.normalized(&app);
    normalized.save(&app).map_err(err)?;
    *state.settings.lock().unwrap() = normalized.clone();
    Ok(normalized)
}

#[tauri::command]
async fn system_info(state: State<'_, AppState>) -> CmdResult<system::SystemInfo> {
    let runtime_dir = state.settings().runtime();
    tauri::async_runtime::spawn_blocking(move || system::info(&runtime_dir))
        .await
        .map_err(err)
}

#[tauri::command]
fn runtime_status(state: State<'_, AppState>) -> runtime::RuntimeStatus {
    runtime::status(&state.settings(), &state.runtime)
}

#[tauri::command]
fn runtime_logs(state: State<'_, AppState>) -> Vec<String> {
    state.runtime.logs.lock().map(|l| l.iter().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
fn runtime_install(app: AppHandle, state: State<'_, AppState>, force: bool, only: Option<Vec<String>>) -> CmdResult<()> {
    let ctl = state.runtime.clone();
    if ctl.installing.swap(true, Ordering::SeqCst) {
        return Err("Une installation est déjà en cours".into());
    }
    ctl.cancel.store(false, Ordering::SeqCst);
    let s = state.settings();
    tauri::async_runtime::spawn(async move {
        // Python must not hold files we are about to replace.
        if only.is_none() || force {
            let st = app.state::<AppState>();
            let _ = backend::stop(&app, &st.backend).await;
        }
        let mut installer = runtime::Installer::new(app.clone(), s, ctl.clone());
        let result = installer.install(force, only).await;
        ctl.installing.store(false, Ordering::SeqCst);
        let payload = match &result {
            Ok(()) => serde_json::json!({"ok": true}),
            Err(e) => serde_json::json!({"ok": false, "error": format!("{e:#}")}),
        };
        let _ = app.emit("runtime://finished", payload);
    });
    Ok(())
}

#[tauri::command]
fn runtime_cancel(state: State<'_, AppState>) {
    state.runtime.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn backend_start(app: AppHandle, state: State<'_, AppState>) -> CmdResult<backend::BackendStatus> {
    let s = state.settings();
    backend::start(&app, &state.backend, &s).await.map_err(err)
}

#[tauri::command]
async fn backend_stop(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    backend::stop(&app, &state.backend).await.map_err(err)
}

#[tauri::command]
async fn backend_restart(app: AppHandle, state: State<'_, AppState>) -> CmdResult<backend::BackendStatus> {
    backend::stop(&app, &state.backend).await.map_err(err)?;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let s = state.settings();
    backend::start(&app, &state.backend, &s).await.map_err(err)
}

#[tauri::command]
async fn backend_status(state: State<'_, AppState>) -> CmdResult<backend::BackendStatus> {
    let s = state.settings();
    Ok(backend::status(&state.backend, &s).await)
}

#[tauri::command]
fn backend_logs(state: State<'_, AppState>) -> Vec<String> {
    state.backend.logs.lock().map(|l| l.iter().cloned().collect()).unwrap_or_default()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WeightsProbe {
    shape: bool,
    paint: bool,
    path: String,
}

/// Check whether a folder looks like a tencent/Hunyuan3D-2.1 checkout.
#[tauri::command]
fn probe_weights(path: String) -> WeightsProbe {
    let p = PathBuf::from(&path);
    WeightsProbe {
        shape: p.join("hunyuan3d-dit-v2-1").join("model.fp16.ckpt").is_file(),
        paint: p.join("hunyuan3d-paintpbr-v2-1").join("model_index.json").is_file(),
        path,
    }
}

#[tauri::command]
fn open_path(path: String) -> CmdResult<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        let _ = std::fs::create_dir_all(&p);
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(err)
}

#[tauri::command]
fn reveal_path(path: String) -> CmdResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(err)
}

#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("URL non autorisée".into());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(err)
}

/// `forge3d --install [--force] [--only uv,python,...]` installs the runtime
/// without UI and exits (unattended setup, CI, debugging the installer).
fn headless_args() -> Option<(bool, Option<Vec<String>>)> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|a| a == "--install") {
        return None;
    }
    let force = args.iter().any(|a| a == "--force");
    let only = args
        .iter()
        .position(|a| a == "--only")
        .and_then(|i| args.get(i + 1))
        .map(|v| v.split(',').map(|s| s.trim().to_string()).collect());
    Some((force, only))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let headless = headless_args();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let settings = Settings::load(&handle);
            app.manage(AppState {
                settings: Mutex::new(settings.clone()),
                runtime: Arc::new(runtime::RuntimeCtl::default()),
                backend: backend::BackendCtl::default(),
            });
            if let Some((force, only)) = headless.clone() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                std::env::set_var("FORGE3D_HEADLESS", "1");
                let ctl = app.state::<AppState>().runtime.clone();
                tauri::async_runtime::spawn(async move {
                    let mut installer = runtime::Installer::new(handle.clone(), settings, ctl);
                    let code = match installer.install(force, only).await {
                        Ok(()) => 0,
                        Err(e) => {
                            eprintln!("install failed: {e:#}");
                            1
                        }
                    };
                    handle.exit(code);
                });
                return Ok(());
            }
            let st = runtime::load_state(&settings);
            if settings.auto_start && runtime::is_ready(&settings, &st) {
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    if let Err(e) = backend::start(&handle, &state.backend, &settings).await {
                        eprintln!("backend autostart failed: {e:#}");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            system_info,
            runtime_status,
            runtime_logs,
            runtime_install,
            runtime_cancel,
            backend_start,
            backend_stop,
            backend_restart,
            backend_status,
            backend_logs,
            probe_weights,
            open_path,
            reveal_path,
            open_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Forge3D");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            state.runtime.cancel.store(true, Ordering::SeqCst);
            backend::kill_now(&state.backend);
        }
    });
}
