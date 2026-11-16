//! First-run runtime installer: uv -> Python 3.10 venv -> Hunyuan3D code ->
//! PyTorch CUDA -> dependencies -> native CUDA/C++ extensions -> smoke test.
//!
//! Every step is idempotent and recorded in `<runtime>/state.json`, so an
//! interrupted install resumes where it stopped.

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::settings::Settings;
use crate::system;
use crate::util::{no_window, path_str};

pub const RUNTIME_VERSION: u32 = 1;
pub const PYTHON_VERSION: &str = "3.10";
pub const TORCH_PINS: [&str; 2] = ["torch==2.5.1", "torchvision==0.20.1"];
/// Upstream commit the backend was written against.
pub const HUNYUAN_COMMIT: &str = "82920d643c0dc2f7bfd7255f45f62d386edfe60c";
/// Prebuilt native extensions for the pinned runtime (Python 3.10, torch 2.5.1,
/// CUDA 12.4, win-x64), so users need neither the CUDA Toolkit nor MSVC.
const NATIVE_PREBUILT_URL: &str =
    "https://github.com/Sutsikii/forge-3D/releases/download/native-v1/forge3d-native-win64-py310-torch251-cu124.zip";
const UV_URL: &str = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip";
/// Requirements we never install: training-only, demo-only, or replaced by us.
const SKIP_PACKAGES: [&str; 6] = ["deepspeed", "tb_nightly", "bpy", "gradio", "pythreejs", "tb-nightly"];
const EXTRA_PACKAGES: [&str; 1] = ["python-multipart==0.0.20"];

pub const STEPS: [(&str, &str); 7] = [
    ("uv", "Gestionnaire de paquets uv"),
    ("python", "Python 3.10 isolé"),
    ("code", "Code Hunyuan3D 2.1"),
    ("torch", "PyTorch CUDA"),
    ("deps", "Dépendances Python"),
    ("native", "Extensions natives (CUDA / C++)"),
    ("verify", "Vérification"),
];

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeState {
    pub version: u32,
    pub done: Vec<String>,
    pub native: BTreeMap<String, bool>,
    pub verify: Option<serde_json::Value>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepInfo {
    pub id: String,
    pub label: String,
    pub done: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub ready: bool,
    pub installing: bool,
    pub steps: Vec<StepInfo>,
    pub native: BTreeMap<String, bool>,
    pub verify: Option<serde_json::Value>,
    pub last_error: Option<String>,
    pub runtime_dir: String,
    pub python: String,
    pub repo_dir: String,
}

#[derive(Serialize, Clone)]
struct StepEvent<'a> {
    id: &'a str,
    status: &'a str,
    message: String,
}

#[derive(Serialize, Clone)]
struct ProgressEvent<'a> {
    id: &'a str,
    done: u64,
    total: u64,
}

#[derive(Default)]
pub struct RuntimeCtl {
    pub installing: AtomicBool,
    pub cancel: Arc<AtomicBool>,
    pub logs: Mutex<VecDeque<String>>,
}

fn state_path(s: &Settings) -> PathBuf {
    s.runtime().join("state.json")
}

pub fn load_state(s: &Settings) -> RuntimeState {
    std::fs::read_to_string(state_path(s))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(s: &Settings, st: &RuntimeState) -> Result<()> {
    std::fs::create_dir_all(s.runtime())?;
    std::fs::write(state_path(s), serde_json::to_string_pretty(st)?)?;
    Ok(())
}

pub fn is_ready(s: &Settings, st: &RuntimeState) -> bool {
    let core = ["uv", "python", "code", "torch", "deps"];
    st.version == RUNTIME_VERSION
        && core.iter().all(|c| st.done.iter().any(|d| d == c))
        && s.venv_python().is_file()
        && s.repo_dir().join("hy3dshape").is_dir()
        && st
            .verify
            .as_ref()
            .and_then(|v| v.pointer("/imports/shape"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
}

pub fn status(s: &Settings, ctl: &RuntimeCtl) -> RuntimeStatus {
    let st = load_state(s);
    RuntimeStatus {
        ready: is_ready(s, &st),
        installing: ctl.installing.load(Ordering::SeqCst),
        steps: STEPS
            .iter()
            .map(|(id, label)| StepInfo {
                id: id.to_string(),
                label: label.to_string(),
                done: st.done.iter().any(|d| d == id),
            })
            .collect(),
        native: st.native.clone(),
        verify: st.verify.clone(),
        last_error: st.last_error.clone(),
        runtime_dir: s.runtime_dir.clone(),
        python: path_str(&s.venv_python()),
        repo_dir: path_str(&s.repo_dir()),
    }
}

// ------------------------------------------------------------------ install

pub struct Installer {
    app: AppHandle,
    s: Settings,
    ctl: Arc<RuntimeCtl>,
    log_file: Option<std::fs::File>,
}

impl Installer {
    pub fn new(app: AppHandle, s: Settings, ctl: Arc<RuntimeCtl>) -> Self {
        let _ = std::fs::create_dir_all(s.runtime().join("logs"));
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(s.runtime().join("logs").join("install.log"))
            .ok();
        Self { app, s, ctl, log_file }
    }

    fn log(&mut self, line: impl Into<String>) {
        let line = line.into();
        if let Some(f) = self.log_file.as_mut() {
            let _ = writeln!(f, "{line}");
        }
        push_log(&self.ctl, &line);
        if std::env::var_os("FORGE3D_HEADLESS").is_some() {
            println!("{line}");
        }
        let _ = self.app.emit("runtime://log", line);
    }

    fn step(&self, id: &str, status: &str, message: impl Into<String>) {
        let _ = self.app.emit("runtime://step", StepEvent { id, status, message: message.into() });
    }

    fn cancelled(&self) -> Result<()> {
        if self.ctl.cancel.load(Ordering::SeqCst) {
            bail!("Installation annulée");
        }
        Ok(())
    }

    fn uv(&self) -> Result<PathBuf> {
        system::find_uv(&self.s.runtime()).ok_or_else(|| anyhow!("uv introuvable"))
    }

    fn base_env(&self, cmd: &mut tokio::process::Command) {
        cmd.env("UV_PYTHON_INSTALL_DIR", self.s.runtime().join("python"))
            .env("UV_HTTP_TIMEOUT", "900")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .env("NO_COLOR", "1");
    }

    /// Run a process, streaming stdout/stderr lines to the UI. Returns stdout lines.
    async fn run(&mut self, program: &Path, args: &[String], cwd: Option<&Path>, envs: &[(&str, String)]) -> Result<Vec<String>> {
        self.cancelled()?;
        self.log(format!("$ {} {}", program.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), args.join(" ")));
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null()).kill_on_drop(true);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        self.base_env(&mut cmd);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        no_window(&mut cmd);
        let mut child = cmd.spawn().with_context(|| format!("lancement de {}", program.display()))?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(bool, String)>();
        let tx2 = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx.send((true, l));
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = tx2.send((false, l));
            }
        });
        let mut out = vec![];
        let cancel = self.ctl.cancel.clone();
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some((is_out, line)) => {
                        if is_out { out.push(line.clone()); }
                        self.log(line);
                    }
                    None => break,
                },
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = child.start_kill();
                        bail!("Installation annulée");
                    }
                }
            }
        }
        let status = child.wait().await?;
        if !status.success() {
            bail!("{} a échoué ({})", program.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(), status);
        }
        Ok(out)
    }

    async fn download(&mut self, id: &str, url: &str, dest: &Path) -> Result<()> {
        self.log(format!("Téléchargement {url}"));
        let client = reqwest::Client::builder().user_agent("Forge3D-Studio").build()?;
        let resp = client.get(url).send().await?.error_for_status()?;
        let total = resp.content_length().unwrap_or(0);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = dest.with_extension("part");
        let mut file = std::fs::File::create(&tmp)?;
        let mut stream = resp.bytes_stream();
        let mut done: u64 = 0;
        let mut last = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            self.cancelled()?;
            let chunk = chunk?;
            file.write_all(&chunk)?;
            done += chunk.len() as u64;
            if last.elapsed().as_millis() > 250 {
                last = std::time::Instant::now();
                let _ = self.app.emit("runtime://progress", ProgressEvent { id, done, total });
            }
        }
        drop(file);
        std::fs::rename(&tmp, dest)?;
        let _ = self.app.emit("runtime://progress", ProgressEvent { id, done, total: total.max(done) });
        Ok(())
    }

    // -- steps ----------------------------------------------------------

    async fn step_uv(&mut self) -> Result<String> {
        if let Some(uv) = system::find_uv(&self.s.runtime()) {
            let v = self.run(&uv, &["--version".into()], None, &[]).await?;
            return Ok(format!("{} ({})", v.join(" "), uv.display()));
        }
        if !cfg!(windows) {
            bail!("Installe uv (https://docs.astral.sh/uv/) puis relance");
        }
        let zip_path = self.s.runtime().join("bin").join("uv.zip");
        self.download("uv", UV_URL, &zip_path).await?;
        let bin = self.s.runtime().join("bin");
        extract_named(&zip_path, &bin, &["uv.exe", "uvx.exe"])?;
        let _ = std::fs::remove_file(&zip_path);
        Ok("uv téléchargé".into())
    }

    async fn step_python(&mut self, force: bool) -> Result<String> {
        let uv = self.uv()?;
        self.run(&uv, &["python".into(), "install".into(), PYTHON_VERSION.into()], None, &[]).await?;
        let venv = self.s.runtime().join("venv");
        let mut args: Vec<String> = vec!["venv".into(), "--python".into(), PYTHON_VERSION.into(), "--seed".into()];
        args.push(if force || !self.s.venv_python().is_file() { "--clear".into() } else { "--allow-existing".into() });
        args.push(path_str(&venv));
        self.run(&uv, &args, None, &[]).await?;
        Ok(format!("venv: {}", venv.display()))
    }

    async fn step_code(&mut self) -> Result<String> {
        let url = format!("https://codeload.github.com/Tencent-Hunyuan/Hunyuan3D-2.1/zip/{HUNYUAN_COMMIT}");
        let zip_path = self.s.runtime().join("hunyuan3d.zip");
        self.download("code", &url, &zip_path).await?;
        let staging = self.s.runtime().join("hunyuan3d.staging");
        let _ = std::fs::remove_dir_all(&staging);
        self.log("Extraction du code…");
        extract_strip(&zip_path, &staging)?;
        let target = self.s.repo_dir();
        if target.exists() {
            std::fs::remove_dir_all(&target).context("suppression de l'ancien code")?;
        }
        std::fs::rename(&staging, &target)?;
        let _ = std::fs::remove_file(&zip_path);
        Ok(format!("commit {}", &HUNYUAN_COMMIT[..8]))
    }

    fn py_args(&self, mut extra: Vec<String>) -> Vec<String> {
        let mut args = vec!["pip".into(), "install".into(), "--python".into(), path_str(&self.s.venv_python())];
        args.append(&mut extra);
        args
    }

    fn ensure_space(&self, needed_gb: f64) -> Result<()> {
        if let Some(free) = system::disk_free_gb(&self.s.runtime()) {
            if free < needed_gb {
                bail!(
                    "Espace disque insuffisant : {free:.1} Go libres, ~{needed_gb:.0} Go nécessaires sur le disque de {}. Libère de la place ou déplace le runtime.",
                    self.s.runtime_dir
                );
            }
        }
        Ok(())
    }

    async fn step_torch(&mut self) -> Result<String> {
        self.ensure_space(16.0)?;
        let uv = self.uv()?;
        let mut extra: Vec<String> = TORCH_PINS.iter().map(|s| s.to_string()).collect();
        extra.extend(["--index-url".into(), self.s.torch_index()]);
        let args = self.py_args(extra);
        self.run(&uv, &args, None, &[]).await?;
        let build_tools = self.py_args(vec!["setuptools<70".into(), "wheel".into(), "pybind11==2.13.4".into(), "ninja==1.11.1.1".into()]);
        self.run(&uv, &build_tools, None, &[]).await?;
        Ok(format!("{} ({})", TORCH_PINS.join(", "), self.s.torch_variant))
    }

    async fn step_deps(&mut self) -> Result<String> {
        self.ensure_space(8.0)?;
        let uv = self.uv()?;
        let req = std::fs::read_to_string(self.s.repo_dir().join("requirements.txt")).context("requirements.txt introuvable")?;
        let filtered = filter_requirements(&req);
        let path = self.s.runtime().join("requirements.forge.txt");
        std::fs::write(&path, filtered.join("\n"))?;
        let mut extra: Vec<String> = vec!["-r".into(), path_str(&path)];
        extra.extend(TORCH_PINS.iter().map(|s| s.to_string()));
        extra.extend(EXTRA_PACKAGES.iter().map(|s| s.to_string()));
        extra.extend([
            "--extra-index-url".into(),
            self.s.torch_index(),
            "--index-strategy".into(),
            "unsafe-best-match".into(),
            // basicsr imports torch from its setup.py.
            "--no-build-isolation-package".into(),
            "basicsr".into(),
        ]);
        let args = self.py_args(extra);
        self.run(&uv, &args, None, &[]).await?;
        Ok(format!("{} paquets", filtered.len()))
    }

    /// Fetch the prebuilt extensions. Only valid for the exact pinned runtime.
    async fn native_prebuilt(&mut self) -> Result<()> {
        if !cfg!(windows) || self.s.torch_variant != "cu124" {
            bail!("pas de binaires précompilés pour cette configuration");
        }
        let zip_path = self.s.runtime().join("native-prebuilt.zip");
        self.download("native", NATIVE_PREBUILT_URL, &zip_path).await?;
        let repo = self.s.repo_dir();
        let result = extract_into(&zip_path, &repo);
        let _ = std::fs::remove_file(&zip_path);
        result?;
        if !(native_artifact(&repo, "rasterizer") && native_artifact(&repo, "inpaint")) {
            bail!("archive incomplète");
        }
        Ok(())
    }

    async fn step_native(&mut self, st: &mut RuntimeState) -> Result<String> {
        match self.native_prebuilt().await {
            Ok(()) => {
                st.native.insert("rasterizer".into(), true);
                st.native.insert("inpaint".into(), true);
                return Ok("extensions précompilées installées".into());
            }
            Err(e) => self.log(format!("Binaires précompilés indisponibles ({e:#}) : compilation locale")),
        }
        let vcvars = system::vcvars();
        let cuda = system::cuda_toolkit();
        let gpus = system::gpus();
        let arch = gpus.first().map(|g| g.compute_cap.clone()).unwrap_or_else(|| "8.6".into());
        let backend = crate::backend::backend_dir(&self.app)?;
        let py = self.s.venv_python();
        let repo = self.s.repo_dir();
        let mut notes = vec![];

        let Some(vcvars) = vcvars else {
            st.native.insert("rasterizer".into(), false);
            st.native.insert("inpaint".into(), false);
            bail!("Visual Studio Build Tools (C++) introuvable : installe « Développement Desktop en C++ » puis recompile.");
        };

        for target in ["inpaint", "rasterizer"] {
            if target == "rasterizer" && cuda.is_none() {
                st.native.insert("rasterizer".into(), false);
                notes.push("custom_rasterizer ignoré : CUDA Toolkit 12.x absent".to_string());
                continue;
            }
            let mut bat = String::from("@echo off\r\n");
            bat += &format!("call \"{vcvars}\" >nul\r\nif errorlevel 1 exit /b 1\r\n");
            if let Some(c) = &cuda {
                bat += &format!("set \"CUDA_HOME={0}\"\r\nset \"CUDA_PATH={0}\"\r\nset \"PATH={0}\\bin;%PATH%\"\r\n", c.path);
            }
            bat += "set DISTUTILS_USE_SDK=1\r\nset MAX_JOBS=4\r\n";
            bat += &format!("set \"TORCH_CUDA_ARCH_LIST={arch}\"\r\n");
            // Newer MSVC than CUDA officially supports: allow it, and silence the STL guard.
            bat += "set \"NVCC_APPEND_FLAGS=-allow-unsupported-compiler -D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH\"\r\n";
            bat += "set \"CL=/D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH\"\r\n";
            bat += &format!(
                "\"{}\" \"{}\" {} \"{}\"\r\n",
                py.display(),
                backend.join("build_native.py").display(),
                target,
                repo.display()
            );
            let bat_path = self.s.runtime().join(format!("build-{target}.bat"));
            std::fs::write(&bat_path, bat)?;
            let result = self.run(Path::new("cmd"), &["/C".into(), path_str(&bat_path)], Some(&self.s.runtime()), &[]).await;
            let marker = result.as_ref().map(|out| out.iter().any(|l| l.contains("FORGE3D_BUILD_OK"))).unwrap_or(false);
            let ok = marker || native_artifact(&repo, target);
            st.native.insert(target.into(), ok);
            if !ok {
                let reason = result.err().map(|e| e.to_string()).unwrap_or_else(|| "pas de module produit".into());
                notes.push(format!("{target} : échec ({reason})"));
            }
            self.cancelled()?;
        }
        let all_ok = st.native.values().all(|v| *v);
        if all_ok {
            Ok("custom_rasterizer + mesh_inpaint_processor compilés".into())
        } else {
            bail!(notes.join(" · "))
        }
    }

    async fn step_verify(&mut self, st: &mut RuntimeState) -> Result<String> {
        let backend = crate::backend::backend_dir(&self.app)?;
        let py = self.s.venv_python();
        let out = self
            .run(
                &py,
                &[path_str(&backend.join("verify.py"))],
                Some(&self.s.repo_dir()),
                &[("FORGE3D_REPO", path_str(&self.s.repo_dir())), ("PYTHONDONTWRITEBYTECODE", "1".into())],
            )
            .await?;
        let json = out
            .iter()
            .rev()
            .find_map(|l| l.strip_prefix("FORGE3D_VERIFY="))
            .ok_or_else(|| anyhow!("verify.py n'a rien renvoyé"))?;
        let value: serde_json::Value = serde_json::from_str(json)?;
        if let Some(native) = value.get("native").and_then(|n| n.as_object()) {
            for (k, v) in native {
                st.native.insert(k.clone(), v.as_bool().unwrap_or(false));
            }
        }
        st.verify = Some(value.clone());
        let shape_ok = value.pointer("/imports/shape").and_then(|v| v.as_bool()).unwrap_or(false);
        let cuda = value.get("cuda").and_then(|v| v.as_bool()).unwrap_or(false);
        if !shape_ok {
            let err = value.pointer("/errors/shape").and_then(|v| v.as_str()).unwrap_or("?");
            bail!("import hy3dshape impossible : {err}");
        }
        let flag = |p: &str| value.pointer(p).and_then(|v| v.as_bool()).unwrap_or(false);
        let paint_ok = flag("/imports/paint") && flag("/imports/rasterizer_run") && flag("/imports/inpaint");
        Ok(format!(
            "torch {} · CUDA {} · texture {}",
            value.get("torch").and_then(|v| v.as_str()).unwrap_or("?"),
            if cuda { "OK" } else { "indisponible" },
            if paint_ok { "OK" } else { "indisponible" }
        ))
    }

    pub async fn install(&mut self, force: bool, only: Option<Vec<String>>) -> Result<()> {
        std::fs::create_dir_all(self.s.runtime())?;
        let mut st = load_state(&self.s);
        if st.version != RUNTIME_VERSION {
            st = RuntimeState { version: RUNTIME_VERSION, ..Default::default() };
        }
        st.last_error = None;
        self.log(format!("=== Forge3D runtime v{RUNTIME_VERSION} → {} ===", self.s.runtime_dir));

        for (id, label) in STEPS {
            if let Some(only) = &only {
                if !only.iter().any(|o| o == id) {
                    continue;
                }
            }
            let already = st.done.iter().any(|d| d == id);
            let explicit = only.is_some();
            if already && !force && !explicit && id != "verify" {
                self.step(id, "done", "déjà installé");
                continue;
            }
            self.step(id, "running", label);
            self.log(format!("--- {label} ---"));
            let result = match id {
                "uv" => self.step_uv().await,
                "python" => self.step_python(force).await,
                "code" => self.step_code().await,
                "torch" => self.step_torch().await,
                "deps" => self.step_deps().await,
                "native" => self.step_native(&mut st).await,
                "verify" => self.step_verify(&mut st).await,
                _ => unreachable!(),
            };
            match result {
                Ok(msg) => {
                    st.done.retain(|d| d != id);
                    st.done.push(id.to_string());
                    if id == "code" {
                        // Fresh sources: the compiled extensions are gone.
                        st.done.retain(|d| d != "native");
                        st.native.clear();
                    }
                    self.log(format!("✔ {label} : {msg}"));
                    self.step(id, "done", msg);
                }
                Err(e) if id == "native" && !self.ctl.cancel.load(Ordering::SeqCst) => {
                    // Shape generation works without the paint extensions.
                    st.done.retain(|d| d != id);
                    self.log(format!("⚠ {label} : {e:#}"));
                    self.step(id, "warning", format!("{e:#}"));
                }
                Err(e) => {
                    st.last_error = Some(format!("{label} : {e:#}"));
                    self.log(format!("✖ {label} : {e:#}"));
                    self.step(id, "error", format!("{e:#}"));
                    save_state(&self.s, &st)?;
                    return Err(e);
                }
            }
            save_state(&self.s, &st)?;
        }
        Ok(())
    }
}

pub fn push_log(ctl: &RuntimeCtl, line: &str) {
    if let Ok(mut logs) = ctl.logs.lock() {
        logs.push_back(line.to_string());
        while logs.len() > 3000 {
            logs.pop_front();
        }
    }
}

/// Whether the compiled module for `target` exists next to its sources.
fn native_artifact(repo: &Path, target: &str) -> bool {
    let (dir, stem) = match target {
        "rasterizer" => (repo.join("hy3dpaint").join("custom_rasterizer"), "custom_rasterizer_kernel"),
        _ => (repo.join("hy3dpaint").join("DifferentiableRenderer"), "mesh_inpaint_processor"),
    };
    std::fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.starts_with(stem) && (name.ends_with(".pyd") || name.ends_with(".so"))
            })
        })
        .unwrap_or(false)
}

fn requirement_name(line: &str) -> String {
    line.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect::<String>()
        .to_lowercase()
        .replace('-', "_")
}

/// Drop pip options, comments, torch itself (pinned separately) and SKIP_PACKAGES.
pub fn filter_requirements(text: &str) -> Vec<String> {
    let skip: Vec<String> = SKIP_PACKAGES.iter().map(|s| s.replace('-', "_")).collect();
    text.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('-'))
        .filter(|l| {
            let name = requirement_name(l);
            let is_torch_core = name == "torch" || name == "torchvision" || name == "torchaudio";
            !is_torch_core && !skip.contains(&name)
        })
        .map(|l| l.to_string())
        .collect()
}

fn extract_named(zip_path: &Path, dest: &Path, names: &[&str]) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    std::fs::create_dir_all(dest)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(path) = entry.enclosed_name() else { continue };
        let Some(fname) = path.file_name().map(|f| f.to_string_lossy().to_string()) else { continue };
        if names.contains(&fname.as_str()) {
            let mut out = std::fs::File::create(dest.join(&fname))?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}

/// Extract an archive as-is into `dest` (paths are kept relative to it).
fn extract_into(zip_path: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = std::fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut f)?;
    }
    Ok(())
}

/// Extract a GitHub archive, dropping its top-level `<repo>-<sha>/` folder.
fn extract_strip(zip_path: &Path, dest: &Path) -> Result<()> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let Some(path) = entry.enclosed_name() else { continue };
        let rel: PathBuf = path.components().skip(1).collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut f)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_requirements() {
        let req = "--extra-index-url https://x\n# c\nninja==1.11.1.1\ntorch==2.5\ntorchmetrics==1.6.0\nbpy==4.0\ndeepspeed\ntb_nightly==2.18\ngradio==5.33.0\ntimm\ntorchdiffeq\npythreejs\n";
        let out = filter_requirements(req);
        assert_eq!(out, vec!["ninja==1.11.1.1", "torchmetrics==1.6.0", "timm", "torchdiffeq"]);
    }
}
