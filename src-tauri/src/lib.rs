mod backend;
mod settings;
mod system;
mod util;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State};

use settings::Settings;

pub struct AppState {
    pub settings: Mutex<Settings>,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings = Settings::load(app.handle());
            app.manage(AppState {
                settings: Mutex::new(settings),
                backend: backend::BackendCtl::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            system_info,
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
            backend::kill_now(&state.backend);
        }
    });
}
