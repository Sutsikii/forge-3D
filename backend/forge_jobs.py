"""Single-GPU job queue. One worker thread runs jobs in submission order."""
from __future__ import annotations

import os
import random
import threading
import time
import traceback
from collections import deque
from typing import Optional

from PIL import Image

import forge_library as lib
from forge_config import CONFIG
from forge_engine import ENGINE
from forge_progress import Cancelled, set_job

STAGE_LABELS = {
    "t2i": "Image depuis le texte",
    "prepare": "Préparation de l'image",
    "shape": "Génération de la forme",
    "post": "Post-traitement",
    "texture": "Texture PBR",
    "save": "Enregistrement",
}
# Relative cost of each stage, used to turn stage progress into a global bar.
STAGE_WEIGHTS = {"t2i": 8, "prepare": 3, "shape": 45, "post": 4, "texture": 45, "save": 1}
# Inner tqdm loops -> slice of their stage.
SUBSTEP_RANGES = {
    "shape": {"Diffusion": (0.0, 0.75), "Volume": (0.75, 1.0), "FlashVDM": (0.75, 1.0)},
}


class Job:
    def __init__(self, kind: str, params: dict, inputs: dict, name: str = "") -> None:
        self.id = lib.new_id()
        self.item_id = params.get("target_item") or self.id
        self.kind = kind
        self.name = name
        self.params = params
        self.inputs = inputs
        self.status = "queued"
        self.created = time.time()
        self.started: Optional[float] = None
        self.finished: Optional[float] = None
        self.stages = self._plan()
        self.stage_index = -1
        self.stage_frac = 0.0
        self.detail = ""
        self.error: Optional[str] = None
        self.warning: Optional[str] = None
        self.cancel_requested = False
        self.timings: dict[str, float] = {}
        self._stage_t0 = 0.0

    def _plan(self) -> list[str]:
        texture = bool(self.params.get("texture", {}).get("enabled"))
        if self.kind == "texture":
            return ["prepare", "texture", "save"]
        stages = ["t2i"] if self.kind == "text" else []
        stages += ["prepare", "shape", "post"]
        if texture:
            stages.append("texture")
        return stages + ["save"]

    # -- progress -------------------------------------------------------
    @property
    def stage(self) -> Optional[str]:
        if 0 <= self.stage_index < len(self.stages):
            return self.stages[self.stage_index]
        return None

    def begin(self, stage: str) -> None:
        if self.stage:
            self.timings[self.stage] = round(time.time() - self._stage_t0, 2)
        self.stage_index = self.stages.index(stage)
        self.stage_frac = 0.0
        self.detail = ""
        self._stage_t0 = time.time()

    def step(self, detail: str) -> None:
        self.detail = detail

    def on_substep(self, desc: str, n: float, total: Optional[float]) -> None:
        if not total:
            return
        frac = min(1.0, n / total)
        lo, hi = 0.0, 1.0
        for key, rng in SUBSTEP_RANGES.get(self.stage or "", {}).items():
            if key.lower() in (desc or "").lower():
                lo, hi = rng
                break
        self.stage_frac = lo + (hi - lo) * frac
        label = desc or "Étape"
        self.detail = f"{label} {int(n)}/{int(total)}"

    @property
    def progress(self) -> float:
        if self.status == "done":
            return 1.0
        weights = [STAGE_WEIGHTS[s] for s in self.stages]
        total = sum(weights)
        done = sum(weights[: max(self.stage_index, 0)])
        current = weights[self.stage_index] * self.stage_frac if self.stage_index >= 0 else 0
        return round((done + current) / total, 4)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "item_id": self.item_id,
            "kind": self.kind,
            "name": self.name,
            "status": self.status,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
            "stages": [{"id": s, "label": STAGE_LABELS[s]} for s in self.stages],
            "stage": self.stage,
            "stage_label": STAGE_LABELS.get(self.stage or "", ""),
            "stage_progress": round(self.stage_frac, 4),
            "progress": self.progress,
            "detail": self.detail,
            "error": self.error,
            "warning": self.warning,
            "params": self.params,
            "timings": self.timings,
        }


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.queue: deque[str] = deque()
        self.current: Optional[Job] = None
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self._loop, name="gpu-worker", daemon=True)
        self.thread.start()

    def submit(self, job: Job) -> Job:
        with self.lock:
            self.jobs[job.id] = job
            self.queue.append(job.id)
            self._trim()
        self.wake.set()
        return job

    def _trim(self, keep: int = 200) -> None:
        finished = [j for j in self.jobs.values() if j.status in ("done", "error", "cancelled")]
        finished.sort(key=lambda j: j.created)
        for j in finished[: max(0, len(finished) - keep)]:
            self.jobs.pop(j.id, None)

    def list(self) -> list[dict]:
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)
        return [j.to_dict() for j in jobs]

    def get(self, job_id: str) -> Optional[Job]:
        return self.jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return False
            if job.status == "queued":
                job.status = "cancelled"
                job.finished = time.time()
                try:
                    self.queue.remove(job_id)
                except ValueError:
                    pass
                return True
            if job.status == "running":
                job.cancel_requested = True
                job.detail = "Annulation…"
                return True
        return False

    def clear_finished(self) -> None:
        with self.lock:
            for jid in [j.id for j in self.jobs.values() if j.status in ("done", "error", "cancelled")]:
                self.jobs.pop(jid, None)

    @property
    def busy(self) -> bool:
        return self.current is not None

    # -- worker ---------------------------------------------------------
    def _loop(self) -> None:
        while True:
            self.wake.wait(1.0)
            with self.lock:
                job_id = self.queue.popleft() if self.queue else None
                if job_id is None:
                    self.wake.clear()
                    continue
                job = self.jobs.get(job_id)
                if job is None or job.status != "queued":
                    continue
                job.status = "running"
                job.started = time.time()
                self.current = job
            set_job(job)
            try:
                run_job(job)
                job.status = "done"
            except Cancelled:
                job.status = "cancelled"
                job.detail = "Annulé"
            except Exception as exc:  # noqa: BLE001 - reported to the UI
                traceback.print_exc()
                job.status = "error"
                job.error = _friendly_error(exc)
            finally:
                if job.stage:
                    job.timings[job.stage] = round(time.time() - job._stage_t0, 2)
                job.finished = time.time()
                set_job(None)
                self.current = None
                if job.status != "done":
                    _free_after_failure()


def _free_after_failure() -> None:
    try:
        import torch

        torch.cuda.empty_cache()
    except Exception:
        pass


def _friendly_error(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    if "out of memory" in low:
        return ("Mémoire GPU insuffisante. Passe sur le profil VRAM « Économe », baisse la résolution "
                "d'octree / de texture ou le nombre de vues. (" + text[:300] + ")")
    if "custom_rasterizer" in low:
        return ("Extension custom_rasterizer indisponible : réinstalle les extensions dans Réglages → Moteur. ("
                + text[:300] + ")")
    if "meshverticeinpaint" in low or "mesh_inpaint" in low:
        return "Extension mesh_inpaint_processor indisponible : réinstalle les extensions. (" + text[:300] + ")"
    return text[:2000]


# ----------------------------------------------------------------- pipelines
def _seed(params: dict) -> int:
    seed = params.get("seed")
    if seed is None or seed == "" or int(seed) < 0:
        seed = random.randint(0, 2**31 - 1)
    params["seed"] = int(seed)
    return int(seed)


def run_job(job: Job) -> None:
    p = job.params
    shape_p = dict(p.get("shape", {}))
    tex_p = dict(p.get("texture", {}))
    d = lib.item_dir(job.item_id)
    os.makedirs(d, exist_ok=True)
    existing = lib.read_meta(job.item_id) if job.kind == "texture" and p.get("target_item") else None
    meta = existing or {
        "id": job.item_id,
        "name": job.name or "Sans titre",
        "kind": job.kind,
        "created": time.time(),
        "files": {},
        "params": p,
    }
    if job.kind != "texture":
        shape_p["seed"] = _seed(shape_p)
        p["shape"] = shape_p
        meta["params"] = p
        meta["seed"] = shape_p["seed"]
    if job.kind == "text":
        meta["prompt"] = p.get("prompt", "")

    # 1. Source image ------------------------------------------------------
    if job.kind == "text":
        job.begin("t2i")
        job.step(f"Modèle {CONFIG.t2i_model}")
        img = ENGINE.text_to_image(p.get("prompt", ""), {**p.get("t2i", {}), "seed": shape_p["seed"]})
        img.save(os.path.join(d, "source.png"))
        meta["files"]["source"] = "source.png"
    else:
        src = job.inputs.get("image")
        if not src:
            raise ValueError("Aucune image fournie")
        img = Image.open(src)
        img.load()
        if src != os.path.join(d, "source.png") and not existing:
            meta["files"]["source"] = os.path.basename(src)

    job.begin("prepare")
    job.step("Détourage" if p.get("remove_bg", "auto") != "never" else "Conversion")
    img = ENGINE.prepare_image(img, p.get("remove_bg", "auto"))
    img.save(os.path.join(d, "input.png"))
    meta["files"]["input"] = "input.png"
    lib.write_meta(meta)

    # 2. Shape -------------------------------------------------------------
    if job.kind in ("image", "text"):
        job.begin("shape")
        job.step("Chargement du modèle de forme")
        mesh = ENGINE.generate_shape(img, shape_p)
        job.begin("post")
        mesh = ENGINE.postprocess(mesh, shape_p, step=job.step)
        shape_path = os.path.join(d, "shape.glb")
        mesh.export(shape_path)
        meta["files"]["shape"] = "shape.glb"
        meta.setdefault("stats", {})["shape"] = lib.mesh_stats(mesh)
        lib.write_meta(meta)
    else:
        shape_path = job.inputs.get("mesh") or os.path.join(d, meta["files"].get("shape", "shape.glb"))
        if not os.path.exists(shape_path):
            raise ValueError("Aucun maillage à texturer")
        if not meta["files"].get("shape"):
            meta["files"]["shape"] = os.path.basename(shape_path)

    # 3. Texture -----------------------------------------------------------
    if "texture" in job.stages:
        job.begin("texture")
        job.step("Chargement du modèle de peinture")
        glb = ENGINE.paint_mesh(shape_path, img, d, tex_p)
        meta["files"]["textured"] = os.path.basename(glb)
        meta["params"]["texture"] = tex_p
        try:
            import trimesh

            meta.setdefault("stats", {})["textured"] = lib.mesh_stats(trimesh.load(glb, force="scene"))
        except Exception:
            pass

    job.begin("save")
    meta["timings"] = {**meta.get("timings", {}), **job.timings}
    meta["error"] = None
    lib.write_meta(meta)
    job.stage_frac = 1.0


JOBS = JobManager()
