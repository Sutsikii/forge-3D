"""On-disk library of generations: one folder per item with a meta.json."""
from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
import time
from typing import Optional

from forge_config import CONFIG

_lock = threading.Lock()
EXPORT_FORMATS = ("glb", "obj", "ply", "stl", "off")


def new_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)


def item_dir(item_id: str) -> str:
    if not item_id or any(c in item_id for c in "/\\:.") or item_id.startswith("~"):
        raise ValueError("identifiant invalide")
    return os.path.join(CONFIG.outputs_dir, item_id)


def safe_file(item_id: str, name: str) -> str:
    base = os.path.realpath(item_dir(item_id))
    path = os.path.realpath(os.path.join(base, name))
    if not path.startswith(base + os.sep):
        raise ValueError("chemin invalide")
    return path


def read_meta(item_id: str) -> Optional[dict]:
    path = os.path.join(item_dir(item_id), "meta.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return None
    return _decorate(meta)


def _decorate(meta: dict) -> dict:
    d = item_dir(meta["id"])
    files = {}
    for key, name in (meta.get("files") or {}).items():
        path = os.path.join(d, name)
        if name and os.path.exists(path):
            files[key] = {"name": name, "mtime": int(os.path.getmtime(path)), "size": os.path.getsize(path)}
    thumb = os.path.join(d, "thumb.png")
    if os.path.exists(thumb):
        files["thumb"] = {"name": "thumb.png", "mtime": int(os.path.getmtime(thumb)), "size": os.path.getsize(thumb)}
    exports = []
    ed = os.path.join(d, "exports")
    if os.path.isdir(ed):
        exports = sorted(os.listdir(ed))
    meta = dict(meta)
    meta["available"] = files
    meta["exports"] = exports
    meta["path"] = d
    return meta


def write_meta(meta: dict) -> dict:
    d = item_dir(meta["id"])
    os.makedirs(d, exist_ok=True)
    meta["updated"] = time.time()
    clean = {k: v for k, v in meta.items() if k not in ("available", "exports", "path")}
    tmp = os.path.join(d, "meta.json.tmp")
    with _lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(clean, f, ensure_ascii=False, indent=2)
        os.replace(tmp, os.path.join(d, "meta.json"))
    return _decorate(clean)


def list_items() -> list[dict]:
    root = CONFIG.outputs_dir
    if not os.path.isdir(root):
        return []
    items = []
    for name in os.listdir(root):
        if not os.path.isfile(os.path.join(root, name, "meta.json")):
            continue
        meta = read_meta(name)
        if meta:
            items.append(meta)
    items.sort(key=lambda m: m.get("created", 0), reverse=True)
    return items


def delete_item(item_id: str) -> None:
    d = item_dir(item_id)
    if os.path.isfile(os.path.join(d, "meta.json")):
        shutil.rmtree(d, ignore_errors=True)


def update_item(item_id: str, changes: dict) -> dict:
    meta = read_meta(item_id)
    if meta is None:
        raise KeyError(item_id)
    for key in ("name", "tags", "favorite", "notes"):
        if key in changes:
            meta[key] = changes[key]
    return write_meta(meta)


def save_thumbnail(item_id: str, data: bytes) -> dict:
    if not data.startswith(b"\x89PNG"):
        raise ValueError("PNG attendu")
    path = safe_file(item_id, "thumb.png")
    with open(path, "wb") as f:
        f.write(data)
    return read_meta(item_id) or {}


def mesh_stats(mesh) -> dict:
    try:
        import trimesh

        if isinstance(mesh, trimesh.Scene):
            verts = sum(len(g.vertices) for g in mesh.geometry.values())
            faces = sum(len(g.faces) for g in mesh.geometry.values() if hasattr(g, "faces"))
            bounds = mesh.bounds
        else:
            verts, faces, bounds = len(mesh.vertices), len(mesh.faces), mesh.bounds
        return {"vertices": int(verts), "faces": int(faces),
                "watertight": bool(getattr(mesh, "is_watertight", False)),
                "extent": [float(x) for x in (bounds[1] - bounds[0])] if bounds is not None else None}
    except Exception:
        return {}


def export_item(item_id: str, variant: str, fmt: str, max_faces: int = 0) -> str:
    """Convert shape/textured GLB to another format inside <item>/exports."""
    import trimesh

    fmt = fmt.lower()
    if fmt not in EXPORT_FORMATS:
        raise ValueError(f"format non supporté: {fmt}")
    meta = read_meta(item_id)
    if meta is None:
        raise KeyError(item_id)
    src_name = (meta.get("files") or {}).get(variant)
    if not src_name:
        raise ValueError(f"pas de fichier « {variant} » pour cet élément")
    src = safe_file(item_id, src_name)
    out_dir = os.path.join(item_dir(item_id), "exports")
    os.makedirs(out_dir, exist_ok=True)
    # Decimation would destroy the UV layout, so it only applies to raw shapes.
    reduce = max_faces > 0 and variant == "shape"
    suffix = f"_{max_faces // 1000}k" if reduce else ""
    out = os.path.join(out_dir, f"{variant}{suffix}.{fmt}")

    scene = trimesh.load(src, force="scene")
    if fmt == "glb" and not reduce:
        scene.export(out)
        return out
    mesh = scene.dump(concatenate=True) if isinstance(scene, trimesh.Scene) else scene
    if reduce and len(mesh.faces) > max_faces:
        from forge_engine import setup_paths

        setup_paths()
        from hy3dshape.postprocessors import FaceReducer

        mesh = FaceReducer()(mesh, max_facenum=max_faces)
    if fmt == "obj":
        # Writes the .mtl and texture images next to the .obj.
        mesh.export(out, include_texture=True)
    else:
        mesh.export(out)
    return out
