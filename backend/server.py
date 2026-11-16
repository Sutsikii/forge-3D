"""Forge3D local API (FastAPI). Started and supervised by the Tauri shell.

Only binds to 127.0.0.1. CORS is limited to the app's own origins so random
web pages opened in a browser cannot drive the GPU or delete the library.
"""
from __future__ import annotations

import argparse
import json
import os
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
from forge_jobs import JOBS  # noqa: E402
from forge_submit import JobError, submit as submit_job  # noqa: E402
from forge_mcp import router as mcp_router  # noqa: E402

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
app.include_router(mcp_router)
STARTED = time.time()


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
    if "hunyuan_dir" in changed:
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
@app.post("/jobs")
def create_job(spec: str = Form(...), image: UploadFile | None = File(None),
               mesh: UploadFile | None = File(None)) -> dict:
    try:
        data = json.loads(spec)
    except ValueError:
        raise HTTPException(400, "spec JSON invalide")
    try:
        job = submit_job(data,
                         (image.filename or "", image.file) if image is not None else None,
                         (mesh.filename or "", mesh.file) if mesh is not None else None)
    except JobError as exc:
        raise HTTPException(exc.status, exc.message)
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
