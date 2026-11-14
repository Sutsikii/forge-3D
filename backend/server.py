"""Forge3D local API (FastAPI). Started and supervised by the Tauri shell.

Only binds to 127.0.0.1. CORS is limited to the app's own origins so random
web pages opened in a browser cannot drive the GPU or delete the library.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402

import forge_library as lib  # noqa: E402
import forge_models as models  # noqa: E402
from forge_config import CONFIG, VERSION  # noqa: E402
from forge_engine import ENGINE, capabilities, gpu_info, setup_paths  # noqa: E402
from forge_jobs import JOBS, Job  # noqa: E402

app = FastAPI(title="Forge3D API", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)
STARTED = time.time()
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MESH_EXT = {".glb", ".gltf", ".obj", ".ply", ".stl", ".off"}


@app.get("/health")
def health() -> dict:
    return {"ok": True, "version": VERSION, "uptime": time.time() - STARTED, "busy": JOBS.busy,
            "loaded": ENGINE.loaded(), "capabilities": capabilities()}


@app.get("/system")
def system() -> dict:
    return {"gpu": gpu_info(), "loaded": ENGINE.loaded(), "config": CONFIG.public(),
            "capabilities": capabilities(), "python": sys.version.split()[0]}


@app.get("/config")
def get_config() -> dict:
    return CONFIG.public()


@app.post("/config")
def set_config(values: dict = Body(...)) -> dict:
    changed = CONFIG.update(values)
    if "flashvdm" in changed or "hunyuan_dir" in changed:
        ENGINE.unload("shape")
    if "hunyuan_dir" in changed or "paint_offload" in changed:
        ENGINE.unload("paint")
    if "t2i_model" in changed:
        ENGINE.unload("t2i")
    if "outputs_dir" in changed:
        os.makedirs(CONFIG.outputs_dir, exist_ok=True)
    return {"changed": changed, "config": CONFIG.public()}


@app.post("/shutdown")
def shutdown() -> dict:
    """Used by the shell to replace a backend orphaned by a crashed session."""
    import threading

    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"ok": True}


@app.post("/unload")
def unload() -> dict:
    if JOBS.busy:
        raise HTTPException(409, "Une génération est en cours")
    ENGINE.unload()
    return {"loaded": ENGINE.loaded(), "gpu": gpu_info()}


# ------------------------------------------------------------------ models
@app.get("/models")
def list_models() -> list:
    return models.status()


@app.post("/models/{model_id}/download")
def download_model(model_id: str) -> dict:
    try:
        return models.start_download(model_id)
    except KeyError:
        raise HTTPException(404, "Modèle inconnu")


# ------------------------------------------------------------------ jobs
def _save_upload(upload: UploadFile, dest_dir: str, stem: str, allowed: set[str]) -> str:
    ext = os.path.splitext(upload.filename or "")[1].lower()
    if ext not in allowed:
        raise HTTPException(400, f"Extension non supportée: {ext or '(aucune)'}")
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, stem + ext)
    with open(path, "wb") as f:
        shutil.copyfileobj(upload.file, f)
    return path


@app.post("/jobs")
def create_job(spec: str = Form(...), image: UploadFile | None = File(None),
               mesh: UploadFile | None = File(None)) -> dict:
    try:
        data = json.loads(spec)
    except ValueError:
        raise HTTPException(400, "spec JSON invalide")
    kind = data.get("kind")
    if kind not in ("image", "text", "texture"):
        raise HTTPException(400, "kind doit valoir image, text ou texture")
    params = data.get("params") or {}
    caps = capabilities()
    if kind in ("image", "text") and not caps["shape"]:
        raise HTTPException(409, "Modèle de forme non installé (onglet Modèles)")
    wants_texture = kind == "texture" or params.get("texture", {}).get("enabled")
    if wants_texture and not caps["paint"]:
        raise HTTPException(409, "Texture indisponible : " + ", ".join(caps["paint_missing"]))
    if kind == "text" and not (params.get("prompt") or "").strip():
        raise HTTPException(400, "Prompt vide")
    if kind == "texture":
        params.setdefault("texture", {})["enabled"] = True

    job = Job(kind, params, {}, name=(data.get("name") or "").strip()[:120])
    d = lib.item_dir(job.item_id)
    target = params.get("target_item")
    if target:
        meta = lib.read_meta(target)
        if meta is None:
            raise HTTPException(404, "Élément cible introuvable")
        job.name = job.name or meta.get("name", "")
        if image is None and meta["files"].get("input"):
            job.inputs["image"] = os.path.join(d, meta["files"]["input"])
        if mesh is None and meta["files"].get("shape"):
            job.inputs["mesh"] = os.path.join(d, meta["files"]["shape"])
    if image is not None:
        job.inputs["image"] = _save_upload(image, d, "source", IMAGE_EXT)
        job.name = job.name or os.path.splitext(image.filename or "image")[0]
    if mesh is not None:
        job.inputs["mesh"] = _save_upload(mesh, d, "uploaded_mesh", MESH_EXT)
        job.name = job.name or os.path.splitext(mesh.filename or "maillage")[0]
    if kind == "text":
        job.name = job.name or params["prompt"].strip()[:60]
    if kind in ("image", "texture") and "image" not in job.inputs:
        raise HTTPException(400, "Image de référence manquante")
    if kind == "texture" and "mesh" not in job.inputs:
        raise HTTPException(400, "Maillage manquant")
    if kind == "texture" and job.inputs["mesh"].lower().endswith((".obj", ".ply", ".stl", ".off", ".gltf")):
        # The paint pipeline expects a single mesh; normalise uploads to GLB.
        import trimesh

        loaded = trimesh.load(job.inputs["mesh"], force="mesh")
        glb = os.path.join(d, "shape.glb")
        loaded.export(glb)
        job.inputs["mesh"] = glb
    JOBS.submit(job)
    return job.to_dict()


@app.get("/jobs")
def list_jobs() -> list:
    return JOBS.list()


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Tâche introuvable")
    return job.to_dict()


@app.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    if not JOBS.cancel(job_id):
        raise HTTPException(409, "Impossible d'annuler cette tâche")
    return {"ok": True}


@app.post("/jobs/clear")
def clear_jobs() -> dict:
    JOBS.clear_finished()
    return {"ok": True}


# ------------------------------------------------------------------ library
@app.get("/library")
def library() -> list:
    return lib.list_items()


@app.get("/library/{item_id}")
def library_item(item_id: str) -> dict:
    meta = lib.read_meta(item_id)
    if meta is None:
        raise HTTPException(404, "Élément introuvable")
    return meta


@app.patch("/library/{item_id}")
def library_update(item_id: str, changes: dict = Body(...)) -> dict:
    try:
        return lib.update_item(item_id, changes)
    except KeyError:
        raise HTTPException(404, "Élément introuvable")


@app.delete("/library/{item_id}")
def library_delete(item_id: str) -> dict:
    running = JOBS.current
    if running and running.item_id == item_id:
        raise HTTPException(409, "Cet élément est en cours de génération")
    lib.delete_item(item_id)
    return {"ok": True}


@app.post("/library/{item_id}/thumbnail")
async def library_thumbnail(item_id: str, request: Request) -> dict:
    data = await request.body()
    try:
        return lib.save_thumbnail(item_id, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.post("/library/{item_id}/export")
def library_export(item_id: str, body: dict = Body(...)) -> dict:
    try:
        path = lib.export_item(item_id, body.get("variant", "textured"), body.get("format", "glb"),
                               int(body.get("max_faces") or 0))
    except KeyError:
        raise HTTPException(404, "Élément introuvable")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"path": path}


@app.get("/files/{item_id}/{name:path}")
def files(item_id: str, name: str):
    try:
        path = lib.safe_file(item_id, name)
    except ValueError:
        raise HTTPException(400, "Chemin invalide")
    if not os.path.isfile(path):
        raise HTTPException(404, "Fichier introuvable")
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47823)
    args = parser.parse_args()
    try:
        setup_paths()
    except Exception as exc:
        print(f"[forge] warning: {exc}")
    import uvicorn

    print(f"[forge] Forge3D backend {VERSION} on http://{args.host}:{args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
