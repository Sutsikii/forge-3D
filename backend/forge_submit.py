"""Validate a job request and queue it. Shared by the HTTP API and the MCP bridge."""
from __future__ import annotations

import os
import shutil
from typing import BinaryIO, Optional, Tuple

import forge_library as lib
from forge_engine import capabilities
from forge_jobs import JOBS, Job

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MESH_EXT = {".glb", ".gltf", ".obj", ".ply", ".stl", ".off"}

# (original filename, readable binary stream)
Source = Tuple[str, BinaryIO]


class JobError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def _save(src: Source, dest_dir: str, stem: str, allowed: set[str]) -> str:
    filename, stream = src
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in allowed:
        raise JobError(400, f"Extension non supportée: {ext or '(aucune)'}")
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, stem + ext)
    with open(path, "wb") as f:
        shutil.copyfileobj(stream, f)
    return path


def submit(data: dict, image: Optional[Source] = None, mesh: Optional[Source] = None) -> Job:
    kind = data.get("kind")
    if kind not in ("image", "text", "texture"):
        raise JobError(400, "kind doit valoir image, text ou texture")
    params = data.get("params") or {}
    caps = capabilities()
    if kind in ("image", "text") and not caps["shape"]:
        raise JobError(409, "Modèle de forme non installé (onglet Modèles)")
    wants_texture = kind == "texture" or params.get("texture", {}).get("enabled")
    if wants_texture and not caps["paint"]:
        raise JobError(409, "Texture indisponible : " + ", ".join(caps["paint_missing"]))
    if kind == "text" and not (params.get("prompt") or "").strip():
        raise JobError(400, "Prompt vide")
    if kind == "texture":
        params.setdefault("texture", {})["enabled"] = True

    job = Job(kind, params, {}, name=(data.get("name") or "").strip()[:120])
    d = lib.item_dir(job.item_id)
    target = params.get("target_item")
    if target:
        meta = lib.read_meta(target)
        if meta is None:
            raise JobError(404, "Élément cible introuvable")
        job.name = job.name or meta.get("name", "")
        if image is None and meta["files"].get("input"):
            job.inputs["image"] = os.path.join(d, meta["files"]["input"])
        if mesh is None and meta["files"].get("shape"):
            job.inputs["mesh"] = os.path.join(d, meta["files"]["shape"])
    if image is not None:
        job.inputs["image"] = _save(image, d, "source", IMAGE_EXT)
        job.name = job.name or os.path.splitext(os.path.basename(image[0] or "image"))[0]
    if mesh is not None:
        job.inputs["mesh"] = _save(mesh, d, "uploaded_mesh", MESH_EXT)
        job.name = job.name or os.path.splitext(os.path.basename(mesh[0] or "maillage"))[0]
    if kind == "text":
        job.name = job.name or params["prompt"].strip()[:60]
    if kind in ("image", "texture") and "image" not in job.inputs:
        raise JobError(400, "Image de référence manquante")
    if kind == "texture" and "mesh" not in job.inputs:
        raise JobError(400, "Maillage manquant")
    if kind == "texture" and job.inputs["mesh"].lower().endswith((".obj", ".ply", ".stl", ".off", ".gltf")):
        # The paint pipeline expects a single mesh; normalise uploads to GLB.
        import trimesh

        loaded = trimesh.load(job.inputs["mesh"], force="mesh")
        glb = os.path.join(d, "shape.glb")
        loaded.export(glb)
        job.inputs["mesh"] = glb
    JOBS.submit(job)
    return job
