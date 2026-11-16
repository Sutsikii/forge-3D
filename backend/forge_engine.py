"""Thin, VRAM-aware wrapper around the Hunyuan3D 2.1 shape and paint pipelines.

Everything model-related lives here so the HTTP layer stays dumb. All public
methods are meant to be called from the single GPU worker thread.
"""
from __future__ import annotations

import gc
import glob
import os
import sys
import time
import types
from typing import Any, Optional

from PIL import Image

from forge_config import CONFIG
from forge_progress import patch_tqdm

_paths_ready = False


def setup_paths() -> None:
    """Make the upstream code importable exactly like upstream demo.py expects."""
    global _paths_ready
    if _paths_ready:
        return
    repo = CONFIG.repo_dir
    if not repo or not os.path.isdir(repo):
        raise RuntimeError(f"Code Hunyuan3D introuvable (FORGE3D_REPO={repo!r})")
    for p in (
        os.path.join(repo, "hy3dpaint", "custom_rasterizer"),
        os.path.join(repo, "hy3dpaint"),
        os.path.join(repo, "hy3dshape"),
        repo,
    ):
        if p not in sys.path:
            sys.path.insert(0, p)
    # Upstream mesh_utils imports bpy (Blender) at module level but only uses
    # it in an OBJ->GLB helper we replace with pygltflib. A stub avoids a
    # 300 MB, Python-3.10-only dependency.
    try:
        import bpy  # noqa: F401
    except Exception:
        sys.modules["bpy"] = types.ModuleType("bpy")
    try:
        from torchvision_fix import apply_fix

        apply_fix()
    except Exception as exc:  # pragma: no cover - best effort
        print(f"[forge] torchvision fix not applied: {exc}")
    _paths_ready = True


def _has(path: str) -> bool:
    return bool(path) and os.path.exists(path)


def native_status() -> dict:
    repo = CONFIG.repo_dir or ""
    raster_dir = os.path.join(repo, "hy3dpaint", "custom_rasterizer")
    inpaint_dir = os.path.join(repo, "hy3dpaint", "DifferentiableRenderer")
    raster = glob.glob(os.path.join(raster_dir, "custom_rasterizer_kernel*.pyd")) + glob.glob(
        os.path.join(raster_dir, "custom_rasterizer_kernel*.so"))
    inpaint = glob.glob(os.path.join(inpaint_dir, "mesh_inpaint_processor*.pyd")) + glob.glob(
        os.path.join(inpaint_dir, "mesh_inpaint_processor*.so"))
    return {"rasterizer": bool(raster), "inpaint": bool(inpaint)}


def capabilities() -> dict:
    h = CONFIG.hunyuan_dir
    native = native_status()
    shape = _has(os.path.join(h, "hunyuan3d-dit-v2-1", "config.yaml"))
    paint_weights = _has(os.path.join(h, "hunyuan3d-paintpbr-v2-1", "model_index.json"))
    realesrgan = _has(CONFIG.realesrgan_path)
    t2i = _has(os.path.join(CONFIG.t2i_dir, "model_index.json"))
    missing_paint = []
    if not paint_weights:
        missing_paint.append("poids Paint PBR")
    if not realesrgan:
        missing_paint.append("RealESRGAN")
    if not _has(os.path.join(CONFIG.dino_dir, "config.json")):
        missing_paint.append("DINOv2 Giant")
    if not native["rasterizer"]:
        missing_paint.append("extension custom_rasterizer (CUDA)")
    if not native["inpaint"]:
        missing_paint.append("extension mesh_inpaint_processor")
    return {
        "shape": shape,
        "paint": not missing_paint,
        "paint_missing": missing_paint,
        "text": t2i and shape,
        "native": native,
    }


def _free_cuda() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def has_real_alpha(img: Image.Image) -> bool:
    if img.mode != "RGBA":
        return False
    lo, _hi = img.getchannel("A").getextrema()
    return lo < 250


class _GpuOnCall:
    """Keep a module in RAM and move it to the GPU only for each call."""

    def __init__(self, module) -> None:
        self.module = module

    def __call__(self, *args, **kwargs):
        self.module.to("cuda")
        try:
            return self.module(*args, **kwargs)
        finally:
            self.module.to("cpu")
            _free_cuda()

    def __getattr__(self, name):
        return getattr(self.module, name)


class Engine:
    def __init__(self) -> None:
        self.shape = None
        self.paint = None
        self.paint_key: Optional[tuple] = None
        self.t2i = None
        self.t2i_key: Optional[str] = None
        self.rembg = None
        self.loaded_at: dict[str, float] = {}

    # ------------------------------------------------------------ memory
    def loaded(self) -> list[str]:
        return [n for n in ("shape", "paint", "t2i", "rembg") if getattr(self, n) is not None]

    def unload(self, *names: str) -> None:
        names = names or ("shape", "paint", "t2i", "rembg")
        for name in names:
            if getattr(self, name, None) is not None:
                setattr(self, name, None)
                self.loaded_at.pop(name, None)
                if name == "paint":
                    self.paint_key = None
                if name == "t2i":
                    self.t2i_key = None
                print(f"[forge] unloaded {name}")
        _free_cuda()

    def _make_room(self, keep: str) -> None:
        """On small GPUs only one big model is resident at a time."""
        if CONFIG.profile_defaults["keep_loaded"]:
            return
        others = [n for n in ("shape", "paint", "t2i") if n != keep and getattr(self, n) is not None]
        if others:
            self.unload(*others)

    # ------------------------------------------------------------ inputs
    def remove_background(self, img: Image.Image) -> Image.Image:
        setup_paths()
        if self.rembg is None:
            os.makedirs(CONFIG.u2net_dir, exist_ok=True)
            from hy3dshape.rembg import BackgroundRemover

            self.rembg = BackgroundRemover()
        return self.rembg(img.convert("RGB"))

    def prepare_image(self, img: Image.Image, mode: str = "auto") -> Image.Image:
        """mode: auto (rembg unless the image already has transparency), always, never."""
        img = img.convert("RGBA")
        if mode == "always" or (mode == "auto" and not has_real_alpha(img)):
            img = self.remove_background(img)
        return img.convert("RGBA")

    # ------------------------------------------------------------ shape
    def load_shape(self) -> None:
        setup_paths()
        self._make_room("shape")
        if self.shape is not None:
            return
        import torch
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

        t0 = time.time()
        pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            CONFIG.hunyuan_dir, subfolder="hunyuan3d-dit-v2-1", device="cuda", dtype=torch.float16
        )
        if CONFIG.flashvdm:
            try:
                pipe.enable_flashvdm(mc_algo="mc")
            except Exception as exc:
                print(f"[forge] FlashVDM unavailable: {exc}")
        self.shape = pipe
        self.loaded_at["shape"] = time.time()
        patch_tqdm()
        print(f"[forge] shape pipeline ready in {time.time() - t0:.1f}s")

    def generate_shape(self, image: Image.Image, p: dict):
        import torch

        self.load_shape()
        gen = torch.Generator().manual_seed(int(p.get("seed", 1234)))
        out = self.shape(
            image=image,
            num_inference_steps=int(p.get("steps", 30)),
            guidance_scale=float(p.get("guidance", 5.0)),
            generator=gen,
            octree_resolution=int(p.get("octree", 256)),
            num_chunks=int(p.get("num_chunks", 8000)),
            output_type="trimesh",
        )
        mesh = out[0] if isinstance(out, (list, tuple)) else out
        if isinstance(mesh, (list, tuple)):
            mesh = mesh[0]
        if mesh is None:
            raise RuntimeError("Aucune surface extraite : essaie une autre image, seed ou résolution d'octree.")
        return mesh

    def postprocess(self, mesh, p: dict, step=None):
        setup_paths()
        from hy3dshape.postprocessors import DegenerateFaceRemover, FaceReducer, FloaterRemover

        if p.get("remove_floaters", True):
            step and step("Suppression des fragments flottants")
            mesh = FloaterRemover()(mesh)
        if p.get("remove_degenerate", True):
            step and step("Nettoyage des faces dégénérées")
            mesh = DegenerateFaceRemover()(mesh)
        max_faces = int(p.get("max_faces", 0) or 0)
        if max_faces > 0 and len(mesh.faces) > max_faces:
            step and step(f"Réduction à {max_faces:,} faces".replace(",", " "))
            mesh = FaceReducer()(mesh, max_facenum=max_faces)
        return mesh

    # ------------------------------------------------------------ paint
    def _patch_snapshot(self) -> None:
        """Serve tencent/Hunyuan3D-2.1 from the local weights folder."""
        import huggingface_hub

        if getattr(huggingface_hub, "_forge_patched", False):
            return
        original = huggingface_hub.snapshot_download

        def snapshot_download(repo_id=None, *args, **kwargs):
            local = CONFIG.hunyuan_dir
            if repo_id == "tencent/Hunyuan3D-2.1" and os.path.exists(
                    os.path.join(local, "hunyuan3d-paintpbr-v2-1", "model_index.json")):
                return local
            return original(repo_id, *args, **kwargs)

        huggingface_hub.snapshot_download = snapshot_download
        huggingface_hub._forge_patched = True

    def load_paint(self, p: dict) -> None:
        setup_paths()
        self._make_room("paint")
        render_size = int(p.get("render_size", 2048))
        texture_size = int(p.get("texture_size", 4096))
        key = (render_size, texture_size)
        if self.paint is not None and self.paint_key == key:
            return
        if self.paint is not None:
            # Only the renderer depends on these sizes; rebuild it, keep models.
            from DifferentiableRenderer.MeshRender import MeshRender
            from utils.pipeline_utils import ViewProcessor

            cfg = self.paint.config
            cfg.render_size, cfg.texture_size = render_size, texture_size
            self.paint.render = MeshRender(default_resolution=render_size, texture_size=texture_size,
                                           bake_mode=cfg.bake_mode, raster_mode=cfg.raster_mode)
            self.paint.view_processor = ViewProcessor(cfg, self.paint.render)
            self._instrument_paint()
            self.paint_key = key
            return

        self._patch_snapshot()
        # Native extensions may have been installed while this process was
        # running; drop cached directory listings so they become importable.
        import importlib

        importlib.invalidate_caches()
        from textureGenPipeline import Hunyuan3DPaintConfig, Hunyuan3DPaintPipeline

        repo = CONFIG.repo_dir
        conf = Hunyuan3DPaintConfig(int(p.get("views", 6)), int(p.get("resolution", 512)))
        conf.realesrgan_ckpt_path = CONFIG.realesrgan_path
        conf.multiview_cfg_path = os.path.join(repo, "hy3dpaint", "cfgs", "hunyuan-paint-pbr.yaml")
        conf.custom_pipeline = os.path.join(repo, "hy3dpaint", "hunyuanpaintpbr")
        conf.multiview_pretrained_path = "tencent/Hunyuan3D-2.1"
        if os.path.exists(os.path.join(CONFIG.dino_dir, "config.json")):
            conf.dino_ckpt_path = CONFIG.dino_dir
        conf.render_size = render_size
        conf.texture_size = texture_size
        t0 = time.time()
        self.paint = Hunyuan3DPaintPipeline(conf)
        mvnet = self.paint.models["multiview_model"]
        mv = mvnet.pipeline
        if not CONFIG.profile_defaults["keep_loaded"] and getattr(mvnet, "dino_v2", None) is not None:
            # DINOv2-giant (~2.2 GB fp16) only encodes the reference image once
            # per job: park it in RAM so the multiview UNet gets that VRAM.
            mvnet.dino_v2 = _GpuOnCall(mvnet.dino_v2.to("cpu"))
            _free_cuda()
        # The pipeline decodes every view (albedo + MR) in one VAE batch; on
        # 12-16 GB cards that overflows into shared memory and crawls.
        # Slicing decodes one image at a time for the same result.
        try:
            mv.vae.enable_slicing()
        except Exception as exc:
            print(f"[forge] vae slicing unavailable: {exc}")
        if CONFIG.paint_offload:
            try:
                mv.enable_model_cpu_offload()
                print("[forge] paint: model CPU offload enabled")
            except Exception as exc:
                print(f"[forge] paint offload failed: {exc}")
        self._instrument_paint()
        self.paint_key = key
        self.loaded_at["paint"] = time.time()
        patch_tqdm()
        print(f"[forge] paint pipeline ready in {time.time() - t0:.1f}s")

    def _instrument_paint(self) -> None:
        """Report each paint phase to the running job and allow cancelling
        between phases (most of them have no inner progress loop)."""
        import textureGenPipeline as tgp

        from forge_progress import check_cancel, get_job

        def wrap(fn, label: str, frac: float):
            def inner(*args, **kwargs):
                check_cancel()
                job = get_job()
                if job is not None:
                    if job.detail != label and not CONFIG.profile_defaults["keep_loaded"]:
                        # Return the previous phase's cached blocks (e.g. the
                        # diffusion activations) before the next one allocates.
                        _free_cuda()
                    job.step(label)
                    job.stage_frac = max(job.stage_frac, frac)
                return fn(*args, **kwargs)

            inner._forge_wrapped = True
            return inner

        def patch(obj, name: str, label: str, frac: float) -> None:
            is_dict = isinstance(obj, dict)
            fn = obj[name] if is_dict else getattr(obj, name)
            if getattr(fn, "_forge_wrapped", False):
                return
            if is_dict:
                obj[name] = wrap(fn, label, frac)
            else:
                setattr(obj, name, wrap(fn, label, frac))

        vp = self.paint.view_processor
        for obj, name, label, frac in (
            (tgp, "remesh_mesh", "Remaillage", 0.02),
            (tgp, "mesh_uv_wrap", "Dépliage UV", 0.06),
            (vp, "render_normal_multiview", "Rendu des normales", 0.12),
            (vp, "render_position_multiview", "Rendu des positions", 0.14),
            (self.paint.models, "multiview_model", "Diffusion multi-vues", 0.16),
            (self.paint.models, "super_model", "Super-résolution", 0.72),
            (vp, "bake_from_multiview", "Projection sur les UV", 0.86),
            (vp, "texture_inpaint", "Remplissage des zones cachées", 0.93),
            (self.paint.render, "save_mesh", "Export du maillage", 0.97),
        ):
            patch(obj, name, label, frac)

    def paint_mesh(self, mesh_path: str, image: Image.Image, out_dir: str, p: dict) -> str:
        self.load_paint(p)
        cfg = self.paint.config
        cfg.max_selected_view_num = int(p.get("views", 6))
        cfg.resolution = int(p.get("resolution", 512))
        obj_path = os.path.join(out_dir, "textured.obj")
        self.paint(mesh_path=mesh_path, image_path=image, output_mesh_path=obj_path,
                   use_remesh=bool(p.get("remesh", True)), save_glb=False)
        glb_path = os.path.join(out_dir, "textured.glb")
        from hy3dpaint.convert_utils import create_glb_with_pbr_materials

        base = obj_path[:-4]
        textures = {}
        for key, suffix in (("albedo", ".jpg"), ("metallic", "_metallic.jpg"), ("roughness", "_roughness.jpg")):
            if os.path.exists(base + suffix):
                textures[key] = base + suffix
        create_glb_with_pbr_materials(obj_path, textures, glb_path)
        return glb_path

    # ------------------------------------------------------------ text
    def load_t2i(self) -> None:
        self._make_room("t2i")
        key = CONFIG.t2i_model
        if self.t2i is not None and self.t2i_key == key:
            return
        self.unload("t2i")
        import torch
        from diffusers import AutoPipelineForText2Image

        src = CONFIG.t2i_dir if os.path.exists(os.path.join(CONFIG.t2i_dir, "model_index.json")) else key
        kwargs: dict[str, Any] = {"torch_dtype": torch.float16}
        try:
            pipe = AutoPipelineForText2Image.from_pretrained(src, variant="fp16", **kwargs)
        except Exception:
            pipe = AutoPipelineForText2Image.from_pretrained(src, **kwargs)
        if CONFIG.profile == "low":
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")
        pipe.set_progress_bar_config(disable=True)
        self.t2i, self.t2i_key = pipe, key
        self.loaded_at["t2i"] = time.time()
        patch_tqdm()

    def text_to_image(self, prompt: str, p: dict) -> Image.Image:
        import torch

        self.load_t2i()
        style = p.get("style_suffix", True)
        full = prompt.strip()
        if style:
            full += (", a single object, centered, full view, isolated on a plain white background, "
                     "soft studio lighting, high detail 3d render")
        turbo = "turbo" in CONFIG.t2i_model.lower()
        steps = int(p.get("t2i_steps", 4 if turbo else 30))
        guidance = float(p.get("t2i_guidance", 0.0 if turbo else 6.0))
        size = int(p.get("t2i_size", 512 if turbo else 1024))
        gen = torch.Generator(device="cpu").manual_seed(int(p.get("seed", 1234)))
        kwargs: dict[str, Any] = dict(prompt=full, num_inference_steps=steps, guidance_scale=guidance,
                                      width=size, height=size, generator=gen)
        if not turbo:
            kwargs["negative_prompt"] = "multiple objects, cropped, cut off, text, watermark, busy background"
        return self.t2i(**kwargs).images[0]


ENGINE = Engine()


def gpu_info() -> dict:
    try:
        import torch

        if not torch.cuda.is_available():
            return {"cuda": False, "torch": torch.__version__}
        free, total = torch.cuda.mem_get_info()
        props = torch.cuda.get_device_properties(0)
        return {
            "cuda": True,
            "torch": torch.__version__,
            "cuda_version": torch.version.cuda,
            "name": props.name,
            "vram_total": total,
            "vram_free": free,
            "vram_reserved": torch.cuda.memory_reserved(0),
        }
    except Exception as exc:
        return {"cuda": False, "error": str(exc)}
