use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::util::{capture, find_in_path, path_str};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub name: String,
    pub vram_mb: u64,
    pub driver: String,
    pub compute_cap: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CudaToolkit {
    pub path: String,
    pub version: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub gpus: Vec<Gpu>,
    pub cuda_toolkit: Option<CudaToolkit>,
    pub vcvars: Option<String>,
    pub uv: Option<String>,
    pub disk_free_gb: Option<f64>,
    pub recommended_profile: String,
}

pub fn gpus() -> Vec<Gpu> {
    let Some(out) = capture(
        "nvidia-smi",
        &["--query-gpu=name,memory.total,driver_version,compute_cap", "--format=csv,noheader,nounits"],
    ) else {
        return vec![];
    };
    out.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split(',').map(|c| c.trim()).collect();
            if cols.len() < 4 {
                return None;
            }
            Some(Gpu {
                name: cols[0].to_string(),
                vram_mb: cols[1].parse().unwrap_or(0),
                driver: cols[2].to_string(),
                compute_cap: cols[3].to_string(),
            })
        })
        .collect()
}

pub fn recommended_profile(gpus: &[Gpu]) -> String {
    let vram = gpus.iter().map(|g| g.vram_mb).max().unwrap_or(0);
    match vram {
        v if v >= 23_000 => "high",
        v if v >= 15_000 => "balanced",
        _ => "low",
    }
    .to_string()
}

fn cuda_version_from_dir(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().trim_start_matches('v').to_string())
        .unwrap_or_default()
}

/// CUDA toolkit with nvcc. torch cu124 wheels want a 12.x toolkit to build
/// the rasterizer; we prefer 12.4 and otherwise take the newest 12.x.
pub fn cuda_toolkit() -> Option<CudaToolkit> {
    let mut candidates: Vec<PathBuf> = vec![];
    for var in ["CUDA_PATH_V12_4", "CUDA_PATH", "CUDA_HOME"] {
        if let Some(p) = std::env::var_os(var) {
            candidates.push(PathBuf::from(p));
        }
    }
    let root = PathBuf::from(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA");
    if let Ok(entries) = std::fs::read_dir(&root) {
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        dirs.reverse();
        // 12.4 first, then newest 12.x, then anything else.
        dirs.sort_by_key(|d| {
            let v = cuda_version_from_dir(d);
            if v == "12.4" {
                0
            } else if v.starts_with("12.") {
                1
            } else {
                2
            }
        });
        candidates.extend(dirs);
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("bin").join(crate::util::exe("nvcc")).is_file())
        .map(|dir| CudaToolkit { version: cuda_version_from_dir(&dir), path: path_str(&dir) })
}

/// vcvars64.bat of a Visual Studio install with the C++ toolchain. CUDA 12.x
/// only officially supports VS 2019/2022, so those win over newer versions.
pub fn vcvars() -> Option<String> {
    let vswhere = PathBuf::from(r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe");
    if !vswhere.is_file() {
        return None;
    }
    let out = capture(
        &path_str(&vswhere),
        &[
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ],
    )?;
    let mut paths: Vec<PathBuf> = out
        .lines()
        .map(|l| PathBuf::from(l.trim()))
        .map(|p| p.join(r"VC\Auxiliary\Build\vcvars64.bat"))
        .filter(|p| p.is_file())
        .collect();
    paths.sort_by_key(|p| {
        let s = path_str(p);
        if s.contains("\\2022\\") {
            0
        } else if s.contains("\\2019\\") {
            1
        } else {
            2
        }
    });
    paths.first().map(|p| path_str(p))
}

pub fn find_uv(runtime_dir: &Path) -> Option<PathBuf> {
    let local = runtime_dir.join("bin").join(crate::util::exe("uv"));
    if local.is_file() {
        return Some(local);
    }
    find_in_path("uv")
}

pub fn disk_free_gb(path: &Path) -> Option<f64> {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    fs2::available_space(&probe).ok().map(|b| b as f64 / 1_073_741_824.0)
}

pub fn info(runtime_dir: &Path) -> SystemInfo {
    let gpus = gpus();
    SystemInfo {
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        recommended_profile: recommended_profile(&gpus),
        gpus,
        cuda_toolkit: cuda_toolkit(),
        vcvars: vcvars(),
        uv: find_uv(runtime_dir).map(|p| path_str(&p)),
        disk_free_gb: disk_free_gb(runtime_dir),
    }
}
