"""Model manager: what is installed, and background downloads with progress."""
from __future__ import annotations

import fnmatch
import os
import threading
import time
import traceback
import urllib.request
from typing import Callable, Optional

from forge_config import CONFIG

REALESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
U2NET_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx"


def _exists(*parts: str) -> bool:
    return os.path.exists(os.path.join(*parts))


SPECS: list[dict] = [
    {
        "id": "shape",
        "name": "Hunyuan3D-DiT v2.1",
        "role": "Forme 3D (image → maillage)",
        "required": True,
        "size_gb": 7.5,
        "repo": "tencent/Hunyuan3D-2.1",
        "patterns": ["hunyuan3d-dit-v2-1/*", "hunyuan3d-vae-v2-1/*"],
        "dir": lambda: CONFIG.hunyuan_dir,
        "check": lambda: _exists(CONFIG.hunyuan_dir, "hunyuan3d-dit-v2-1", "model.fp16.ckpt"),
    },
    {
        "id": "paint",
        "name": "Hunyuan3D-Paint PBR v2.1",
        "role": "Texture PBR multi-vues (albedo, métal, rugosité)",
        "required": False,
        "size_gb": 6.5,
        "repo": "tencent/Hunyuan3D-2.1",
        "patterns": ["hunyuan3d-paintpbr-v2-1/*"],
        "dir": lambda: CONFIG.hunyuan_dir,
        "check": lambda: _exists(CONFIG.hunyuan_dir, "hunyuan3d-paintpbr-v2-1", "unet", "diffusion_pytorch_model.bin"),
    },
    {
        "id": "dino",
        "name": "DINOv2 Giant",
        "role": "Encodeur d'image utilisé par la texture",
        "required": False,
        "size_gb": 4.4,
        "repo": "facebook/dinov2-giant",
        "patterns": ["*.json", "*.safetensors", "*.txt"],
        "dir": lambda: CONFIG.dino_dir,
        "check": lambda: _exists(CONFIG.dino_dir, "model.safetensors"),
    },
    {
        "id": "realesrgan",
        "name": "Real-ESRGAN x4",
        "role": "Super-résolution des vues de texture",
        "required": False,
        "size_gb": 0.07,
        "url": REALESRGAN_URL,
        "file": lambda: CONFIG.realesrgan_path,
        "check": lambda: os.path.exists(CONFIG.realesrgan_path),
    },
    {
        "id": "rembg",
        "name": "U²-Net (rembg)",
        "role": "Détourage automatique des images",
        "required": True,
        "size_gb": 0.17,
        "url": U2NET_URL,
        "file": lambda: os.path.join(CONFIG.u2net_dir, "u2net.onnx"),
        "check": lambda: _exists(CONFIG.u2net_dir, "u2net.onnx"),
    },
    {
        "id": "t2i",
        "name": "Texte → image",
        "role": "Génère l'image de référence pour le mode Texte → 3D",
        "required": False,
        "size_gb": 7.0,
        "repo": None,  # resolved from CONFIG.t2i_model
        "patterns": ["model_index.json", "*/config.json", "*/*.json", "*/*.txt", "*/*.fp16.safetensors"],
        "dir": lambda: CONFIG.t2i_dir,
        "check": lambda: _exists(CONFIG.t2i_dir, "model_index.json"),
    },
]
SPEC_BY_ID = {s["id"]: s for s in SPECS}


class Download:
    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.total = 0
        self.done = 0
        self.status = "running"
        self.error: Optional[str] = None
        self.started = time.time()
        self.speed = 0.0
        self._last = (time.time(), 0)

    def tick(self, done: int) -> None:
        now = time.time()
        t, d = self._last
        if now - t >= 1.0:
            self.speed = max(0.0, (done - d) / (now - t))
            self._last = (now, done)
        self.done = done

    def to_dict(self) -> dict:
        return {"status": self.status, "total": self.total, "done": self.done, "speed": self.speed,
                "error": self.error,
                "progress": (self.done / self.total) if self.total else 0.0}


_downloads: dict[str, Download] = {}
_lock = threading.Lock()


def _repo_for(spec: dict) -> str:
    return spec["repo"] or CONFIG.t2i_model


def status() -> list[dict]:
    out = []
    for spec in SPECS:
        dl = _downloads.get(spec["id"])
        location = spec["file"]() if "file" in spec else spec["dir"]()
        out.append({
            "id": spec["id"],
            "name": spec["name"] if spec["id"] != "t2i" else f"{spec['name']} · {CONFIG.t2i_model}",
            "role": spec["role"],
            "required": spec["required"],
            "size_gb": spec["size_gb"],
            "source": spec.get("url") or f"huggingface.co/{_repo_for(spec)}",
            "path": location,
            "installed": bool(spec["check"]()),
            "download": dl.to_dict() if dl else None,
        })
    return out


def start_download(model_id: str) -> dict:
    spec = SPEC_BY_ID.get(model_id)
    if spec is None:
        raise KeyError(model_id)
    with _lock:
        current = _downloads.get(model_id)
        if current and current.status == "running":
            return current.to_dict()
        dl = Download(model_id)
        _downloads[model_id] = dl
    target: Callable[[Download, dict], None] = _download_url if "url" in spec else _download_hf
    threading.Thread(target=_run, args=(target, dl, spec), daemon=True, name=f"dl-{model_id}").start()
    return dl.to_dict()


def _run(fn, dl: Download, spec: dict) -> None:
    try:
        fn(dl, spec)
        dl.status = "done"
        dl.done = dl.total or dl.done
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        dl.status = "error"
        dl.error = f"{type(exc).__name__}: {exc}"[:500]


def _download_url(dl: Download, spec: dict) -> None:
    path = spec["file"]()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    req = urllib.request.Request(spec["url"], headers={"User-Agent": "Forge3D"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
        dl.total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            dl.tick(done)
    os.replace(tmp, path)


def _download_hf(dl: Download, spec: dict) -> None:
    from huggingface_hub import HfApi, snapshot_download

    repo = _repo_for(spec)
    patterns = spec["patterns"]
    local_dir = spec["dir"]()
    os.makedirs(local_dir, exist_ok=True)

    info = HfApi().model_info(repo, files_metadata=True)
    files = {s.rfilename: (s.size or 0) for s in info.siblings
             if any(fnmatch.fnmatch(s.rfilename, pat) for pat in patterns)}
    dl.total = sum(files.values())

    stop = threading.Event()

    def poll() -> None:
        cache = os.path.join(local_dir, ".cache", "huggingface", "download")
        while not stop.wait(1.0):
            done = 0
            for name, size in files.items():
                p = os.path.join(local_dir, name)
                if os.path.exists(p):
                    done += os.path.getsize(p)
            for root, _dirs, names in os.walk(cache):
                for n in names:
                    if n.endswith(".incomplete"):
                        try:
                            done += os.path.getsize(os.path.join(root, n))
                        except OSError:
                            pass
            dl.tick(min(done, dl.total or done))

    poller = threading.Thread(target=poll, daemon=True)
    poller.start()
    try:
        snapshot_download(repo_id=repo, allow_patterns=patterns, local_dir=local_dir)
    finally:
        stop.set()
