"""Runtime configuration for the Forge3D backend.

Initial values come from environment variables set by the Tauri shell; the
mutable subset can be changed at runtime through POST /config.
"""
from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass, field, fields

VERSION = "0.1.0"

PROFILES = {
    # VRAM profile -> defaults used by the UI and by the engine when a job does
    # not override them. "keep_loaded" decides whether shape and paint models
    # can live on the GPU at the same time.
    "low": {"keep_loaded": False, "views": 6, "resolution": 512, "texture_size": 2048, "render_size": 2048,
            "octree": 256, "num_chunks": 8000},
    "balanced": {"keep_loaded": False, "views": 6, "resolution": 512, "texture_size": 4096, "render_size": 2048,
                 "octree": 384, "num_chunks": 20000},
    "high": {"keep_loaded": True, "views": 8, "resolution": 768, "texture_size": 4096, "render_size": 2048,
             "octree": 384, "num_chunks": 50000},
}


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _slug(repo_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "--", repo_id)


@dataclass
class Config:
    repo_dir: str = field(default_factory=lambda: _env("FORGE3D_REPO"))
    hunyuan_dir: str = field(default_factory=lambda: _env("FORGE3D_HUNYUAN"))
    models_dir: str = field(default_factory=lambda: _env("FORGE3D_MODELS"))
    outputs_dir: str = field(default_factory=lambda: _env("FORGE3D_OUTPUTS"))
    profile: str = field(default_factory=lambda: _env("FORGE3D_PROFILE", "low"))
    flashvdm: bool = field(default_factory=lambda: _env("FORGE3D_FLASHVDM", "1") == "1")
    t2i_model: str = field(default_factory=lambda: _env("FORGE3D_T2I", "stabilityai/sdxl-turbo"))

    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    MUTABLE = ("profile", "flashvdm", "t2i_model", "hunyuan_dir", "outputs_dir")

    def __post_init__(self) -> None:
        if not self.models_dir:
            self.models_dir = os.path.join(os.path.expanduser("~"), ".forge3d", "models")
        if not self.hunyuan_dir:
            self.hunyuan_dir = os.path.join(self.models_dir, "Hunyuan3D-2.1")
        if not self.outputs_dir:
            self.outputs_dir = os.path.join(os.path.expanduser("~"), "Documents", "Forge3D")
        if self.profile not in PROFILES:
            self.profile = "low"
        for d in (self.models_dir, self.outputs_dir):
            os.makedirs(d, exist_ok=True)

    # Derived locations -------------------------------------------------
    @property
    def realesrgan_path(self) -> str:
        return os.path.join(self.models_dir, "RealESRGAN_x4plus.pth")

    @property
    def dino_dir(self) -> str:
        return os.path.join(self.models_dir, "dinov2-giant")

    @property
    def t2i_dir(self) -> str:
        return os.path.join(self.models_dir, "t2i", _slug(self.t2i_model))

    @property
    def u2net_dir(self) -> str:
        return os.path.join(self.models_dir, "u2net")

    @property
    def profile_defaults(self) -> dict:
        return PROFILES[self.profile]

    def update(self, values: dict) -> list[str]:
        changed = []
        with self._lock:
            for key, value in values.items():
                if key not in self.MUTABLE:
                    continue
                if key == "profile" and value not in PROFILES:
                    continue
                if key == "flashvdm":
                    value = bool(value)
                if getattr(self, key) != value:
                    setattr(self, key, value)
                    changed.append(key)
        return changed

    def public(self) -> dict:
        data = {f.name: getattr(self, f.name) for f in fields(self) if not f.name.startswith("_")}
        data.update(
            realesrgan_path=self.realesrgan_path,
            dino_dir=self.dino_dir,
            t2i_dir=self.t2i_dir,
            profile_defaults=self.profile_defaults,
            profiles=PROFILES,
            version=VERSION,
        )
        return data


CONFIG = Config()
# rembg reads this when it fetches u2net.onnx; keep it next to the other models.
os.environ.setdefault("U2NET_HOME", CONFIG.u2net_dir)
