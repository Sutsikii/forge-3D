use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::util::path_str;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub runtime_dir: String,
    pub models_dir: String,
    pub hunyuan_dir: String,
    pub outputs_dir: String,
    pub port: u16,
    pub vram_profile: String,
    pub flashvdm: bool,
    pub paint_offload: bool,
    pub t2i_model: String,
    pub torch_variant: String,
    pub auto_start: bool,
    pub license_accepted: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            runtime_dir: String::new(),
            models_dir: String::new(),
            hunyuan_dir: String::new(),
            outputs_dir: String::new(),
            port: 47823,
            vram_profile: String::new(),
            flashvdm: true,
            paint_offload: false,
            t2i_model: "stabilityai/sdxl-turbo".into(),
            torch_variant: "cu124".into(),
            auto_start: true,
            license_accepted: false,
        }
    }
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

impl Settings {
    /// Fill every empty field from the platform locations / hardware.
    fn complete(mut self, app: &AppHandle) -> Self {
        let data = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
        if self.runtime_dir.is_empty() {
            self.runtime_dir = path_str(&data.join("runtime"));
        }
        if self.models_dir.is_empty() {
            self.models_dir = path_str(&data.join("models"));
        }
        if self.hunyuan_dir.is_empty() {
            self.hunyuan_dir = path_str(&PathBuf::from(&self.models_dir).join("Hunyuan3D-2.1"));
        }
        if self.outputs_dir.is_empty() {
            let docs = app.path().document_dir().unwrap_or_else(|_| data.clone());
            self.outputs_dir = path_str(&docs.join("Forge3D"));
        }
        if !["low", "balanced", "high"].contains(&self.vram_profile.as_str()) {
            self.vram_profile = crate::system::recommended_profile(&crate::system::gpus());
        }
        if self.port == 0 {
            self.port = 47823;
        }
        self
    }

    pub fn load(app: &AppHandle) -> Self {
        let path = settings_path(app);
        let loaded: Settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let complete = loaded.complete(app);
        if !path.exists() {
            let _ = complete.save(app);
        }
        complete
    }

    pub fn save(&self, app: &AppHandle) -> anyhow::Result<()> {
        let path = settings_path(app);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn normalized(self, app: &AppHandle) -> Self {
        self.complete(app)
    }

    pub fn runtime(&self) -> PathBuf {
        PathBuf::from(&self.runtime_dir)
    }

    pub fn venv_python(&self) -> PathBuf {
        let venv = self.runtime().join("venv");
        if cfg!(windows) {
            venv.join("Scripts").join("python.exe")
        } else {
            venv.join("bin").join("python")
        }
    }

    pub fn repo_dir(&self) -> PathBuf {
        self.runtime().join("hunyuan3d")
    }

    pub fn torch_index(&self) -> String {
        format!("https://download.pytorch.org/whl/{}", self.torch_variant)
    }
}
