"""Model Context Protocol endpoint (Streamable HTTP transport, JSON responses).

Lets an MCP client (an AI assistant, an IDE...) drive Forge3D: generate meshes,
follow the queue, browse and export the library. Served by the backend at
POST /mcp, so there is nothing extra to install or start.

Only plain request/response JSON-RPC is implemented: every tool answers in a
single response, long generations are followed with forge_job(wait_seconds).
"""
from __future__ import annotations

import base64
import json
import os
import time
import traceback
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response

import forge_library as lib
from forge_config import CONFIG, PROFILES, VERSION
from forge_engine import capabilities, gpu_info
from forge_jobs import JOBS
from forge_submit import JobError, submit

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
ALLOWED_ORIGINS = {"http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
                   "http://localhost:1420", "http://127.0.0.1:1420"}
MAX_WAIT = 900

router = APIRouter()


class ToolError(Exception):
    """Reported to the client as a tool result with isError=true."""


@dataclass
class Tool:
    name: str
    description: str
    schema: dict
    fn: Callable[[dict], Any]

    def describe(self) -> dict:
        return {"name": self.name, "description": self.description, "inputSchema": self.schema}


TOOLS: dict[str, Tool] = {}


def tool(name: str, description: str, properties: dict | None = None, required: list[str] | None = None):
    schema = {"type": "object", "properties": properties or {}, "additionalProperties": False}
    if required:
        schema["required"] = required

    def wrap(fn: Callable[[dict], Any]):
        TOOLS[name] = Tool(name, description, schema, fn)
        return fn

    return wrap


def image_content(path: str) -> dict:
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    mime = "image/png" if path.lower().endswith(".png") else "image/jpeg"
    return {"type": "image", "data": data, "mimeType": mime}


# ---------------------------------------------------------------- helpers
def _job_summary(job: dict) -> dict:
    keys = ("id", "item_id", "kind", "name", "status", "stage_label", "progress", "detail", "error", "warning",
            "timings")
    out = {k: job.get(k) for k in keys}
    if job.get("status") == "done":
        meta = lib.read_meta(job["item_id"])
        if meta:
            out["files"] = _files(meta)
    return out


def _files(meta: dict) -> dict:
    return {k: os.path.join(meta["path"], v["name"]) for k, v in meta.get("available", {}).items()}


def _item_summary(meta: dict) -> dict:
    return {
        "id": meta["id"],
        "name": meta.get("name", ""),
        "kind": meta.get("kind"),
        "prompt": meta.get("prompt") or None,
        "created": time.strftime("%Y-%m-%d %H:%M", time.localtime(meta.get("created", 0))),
        "textured": "textured" in meta.get("available", {}),
        "stats": meta.get("stats"),
        "files": _files(meta),
        "exports": meta.get("exports", []),
        "tags": meta.get("tags", []),
    }


def _wait(job_id: str, seconds: float) -> dict:
    deadline = time.time() + max(0.0, min(float(seconds or 0), MAX_WAIT))
    while True:
        job = JOBS.get(job_id)
        if job is None:
            raise ToolError(f"Unknown job {job_id}")
        if job.status in ("done", "error", "cancelled") or time.time() >= deadline:
            return _job_summary(job.to_dict())
        time.sleep(0.5)


def _shape_params(quality: str, seed: int | None) -> dict:
    p = PROFILES[CONFIG.profile]
    steps, octree = 30, p["octree"]
    if quality == "draft":
        steps, octree = 15, 256
    elif quality == "quality":
        steps, octree = 50, 384 if CONFIG.profile == "low" else 512
    return {"steps": steps, "guidance": 5.0, "octree": octree, "num_chunks": p["num_chunks"],
            "seed": -1 if seed is None else int(seed), "remove_floaters": True, "remove_degenerate": True,
            "max_faces": 0}


def _texture_params(enabled: bool) -> dict:
    p = PROFILES[CONFIG.profile]
    return {"enabled": enabled, "views": p["views"], "resolution": p["resolution"],
            "texture_size": p["texture_size"], "render_size": 2048, "remesh": True}


def _open_local(path: str):
    path = os.path.abspath(os.path.expanduser(path or ""))
    if not os.path.isfile(path):
        raise ToolError(f"File not found: {path}")
    return path, open(path, "rb")


def _submit(data: dict, image_path: str | None = None, mesh_path: str | None = None) -> dict:
    handles = []
    try:
        image = mesh = None
        if image_path:
            image = _open_local(image_path)
            handles.append(image[1])
        if mesh_path:
            mesh = _open_local(mesh_path)
            handles.append(mesh[1])
        try:
            return submit(data, image, mesh).to_dict()
        except JobError as exc:
            raise ToolError(exc.message)
    finally:
        for h in handles:
            h.close()


def _meta(item_id: str) -> dict:
    try:
        meta = lib.read_meta(item_id)
    except ValueError:
        meta = None
    if meta is None:
        raise ToolError(f"Unknown library item {item_id}")
    return meta


# ---------------------------------------------------------------- tools
WAIT = {"type": "integer", "minimum": 0, "maximum": MAX_WAIT,
        "description": "Block up to this many seconds for the job to finish (0 = return immediately)."}


@tool("forge_status", "Forge3D backend state: GPU, VRAM profile, installed capabilities and job queue.")
def t_status(_: dict) -> dict:
    jobs = JOBS.list()
    return {
        "version": VERSION,
        "gpu": gpu_info(),
        "profile": CONFIG.profile,
        "capabilities": capabilities(),
        "outputs_dir": CONFIG.outputs_dir,
        "busy": JOBS.busy,
        "queue": [_job_summary(j) for j in jobs if j["status"] in ("queued", "running")],
    }


@tool(
    "forge_generate",
    "Generate a 3D mesh with Hunyuan3D 2.1, from a reference image on disk (best results: one object, "
    "plain background) or from a text prompt (needs the text-to-image model). Optionally paints PBR "
    "textures. Shape takes ~1-2 min, texture ~4-5 min on a 12 GB GPU. Returns the job; follow it with "
    "forge_job or pass wait_seconds.",
    {
        "image_path": {"type": "string", "description": "Absolute path of a PNG/JPG/WEBP reference image."},
        "prompt": {"type": "string", "description": "Text description, used when no image_path is given."},
        "name": {"type": "string"},
        "texture": {"type": "boolean", "default": True, "description": "Also paint PBR textures."},
        "quality": {"type": "string", "enum": ["draft", "standard", "quality"], "default": "standard"},
        "seed": {"type": "integer"},
        "remove_background": {"type": "string", "enum": ["auto", "always", "never"], "default": "auto"},
        "wait_seconds": WAIT,
    },
)
def t_generate(a: dict) -> dict:
    image_path, prompt = a.get("image_path"), (a.get("prompt") or "").strip()
    if not image_path and not prompt:
        raise ToolError("Give image_path or prompt")
    caps = capabilities()
    texture = bool(a.get("texture", True))
    if texture and not caps["paint"]:
        raise ToolError("Texturing unavailable: " + ", ".join(caps["paint_missing"]) + ". Set texture=false.")
    params = {"shape": _shape_params(a.get("quality", "standard"), a.get("seed")),
              "texture": _texture_params(texture), "remove_bg": a.get("remove_background", "auto")}
    kind = "image" if image_path else "text"
    if kind == "text":
        if not caps["text"]:
            raise ToolError("Text-to-image model not installed (Models tab of the app). Give an image_path.")
        params.update({"prompt": prompt, "t2i": {"style_suffix": True}})
    job = _submit({"kind": kind, "name": a.get("name", ""), "params": params}, image_path=image_path)
    return _wait(job["id"], a.get("wait_seconds", 0))


@tool(
    "forge_texture",
    "Paint (or repaint) PBR textures on an existing library item, optionally with a new reference image.",
    {"item_id": {"type": "string"}, "image_path": {"type": "string"}, "wait_seconds": WAIT},
    ["item_id"],
)
def t_texture(a: dict) -> dict:
    _meta(a["item_id"])
    params = {"target_item": a["item_id"], "texture": _texture_params(True)}
    job = _submit({"kind": "texture", "params": params}, image_path=a.get("image_path"))
    return _wait(job["id"], a.get("wait_seconds", 0))


@tool(
    "forge_job",
    "Progress of a job. With wait_seconds, blocks until it finishes or the delay expires. Finished jobs "
    "list their output files.",
    {"job_id": {"type": "string"}, "wait_seconds": WAIT},
    ["job_id"],
)
def t_job(a: dict) -> dict:
    return _wait(a["job_id"], a.get("wait_seconds", 0))


@tool("forge_cancel", "Cancel a queued or running job.", {"job_id": {"type": "string"}}, ["job_id"])
def t_cancel(a: dict) -> dict:
    if not JOBS.cancel(a["job_id"]):
        raise ToolError("This job cannot be cancelled")
    return {"ok": True}


@tool(
    "forge_library",
    "List generated models, newest first, with their file paths.",
    {"search": {"type": "string", "description": "Filter on name, prompt or tag."},
     "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 20}},
)
def t_library(a: dict) -> list:
    q = (a.get("search") or "").lower().strip()
    items = []
    for meta in lib.list_items():
        hay = " ".join([meta.get("name", ""), meta.get("prompt", "") or "", *meta.get("tags", [])]).lower()
        if q and q not in hay:
            continue
        items.append(_item_summary(meta))
        if len(items) >= int(a.get("limit", 20)):
            break
    return items


@tool(
    "forge_item",
    "Details of one library item. With preview=true also returns its thumbnail (or reference image).",
    {"item_id": {"type": "string"}, "preview": {"type": "boolean", "default": True}},
    ["item_id"],
)
def t_item(a: dict):
    meta = _meta(a["item_id"])
    out: list = [{"type": "text", "text": json.dumps({**_item_summary(meta), "params": meta.get("params")},
                                                     ensure_ascii=False, indent=2)}]
    if a.get("preview", True):
        files = _files(meta)
        pic = files.get("thumb") or files.get("input")
        if pic and pic.lower().endswith((".png", ".jpg", ".jpeg")):
            out.append(image_content(pic))
    return out


@tool(
    "forge_export",
    "Convert a library item to glb/obj/ply/stl/off. max_faces decimates (untextured shape only). "
    "Returns the written file path.",
    {"item_id": {"type": "string"}, "variant": {"type": "string", "enum": ["textured", "shape"], "default": "textured"},
     "format": {"type": "string", "enum": list(lib.EXPORT_FORMATS), "default": "glb"},
     "max_faces": {"type": "integer", "minimum": 0}},
    ["item_id"],
)
def t_export(a: dict) -> dict:
    meta = _meta(a["item_id"])
    variant = a.get("variant", "textured")
    if variant == "textured" and "textured" not in meta.get("available", {}):
        variant = "shape"
    try:
        path = lib.export_item(a["item_id"], variant, a.get("format", "glb"), int(a.get("max_faces") or 0))
    except ValueError as exc:
        raise ToolError(str(exc))
    return {"path": path, "variant": variant}


# ---------------------------------------------------------------- JSON-RPC
def _result_content(value: Any) -> list:
    if isinstance(value, list) and value and isinstance(value[0], dict) and value[0].get("type") in ("text", "image"):
        return value
    return [{"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2, default=str)}]


async def _call_tool(params: dict) -> dict:
    t = TOOLS.get(params.get("name", ""))
    if t is None:
        raise KeyError(params.get("name"))
    args = params.get("arguments") or {}
    try:
        value = await run_in_threadpool(t.fn, args)
        return {"content": _result_content(value), "isError": False}
    except ToolError as exc:
        return {"content": [{"type": "text", "text": str(exc)}], "isError": True}
    except Exception as exc:  # noqa: BLE001 - surfaced to the client
        traceback.print_exc()
        return {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}], "isError": True}


async def _handle(msg: dict) -> dict | None:
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:  # notification (initialized, cancelled...)
        return None
    try:
        if method == "initialize":
            asked = (msg.get("params") or {}).get("protocolVersion")
            result = {
                "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "forge3d", "title": "Forge3D Studio", "version": VERSION},
                "instructions": (
                    "Forge3D generates textured 3D meshes on the local GPU. Jobs run one at a time: start "
                    "with forge_generate, then poll forge_job with wait_seconds. Results land in the "
                    "library (forge_library)."
                ),
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": [t.describe() for t in TOOLS.values()]}
        elif method == "tools/call":
            try:
                result = await _call_tool(msg.get("params") or {})
            except KeyError as exc:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown tool {exc}"}}
        elif method in ("resources/list", "prompts/list"):
            result = {method.split("/")[0]: []}
        else:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(exc)}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


@router.post("/mcp")
async def mcp_post(request: Request):
    # Browsers always send Origin; MCP clients do not. Refuse foreign pages
    # (DNS rebinding) while letting local clients and the app through.
    origin = request.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:
        return JSONResponse({"error": "origin not allowed"}, status_code=403)
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
                            status_code=400)
    batch = body if isinstance(body, list) else [body]
    replies = [r for r in [await _handle(m) for m in batch if isinstance(m, dict)] if r is not None]
    if not replies:
        return Response(status_code=202)
    return JSONResponse(replies if isinstance(body, list) else replies[0])


@router.get("/mcp")
def mcp_get():
    # No server-initiated stream.
    return Response(status_code=405, headers={"Allow": "POST"})


@router.delete("/mcp")
def mcp_delete():
    return Response(status_code=200)
