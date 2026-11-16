"""MCP tools that talk to the Forge3D Bridge running inside the Unity Editor.

The bridge (unity/com.forge3d.bridge) listens on 127.0.0.1:47824 by default;
FORGE3D_UNITY_PORT overrides it.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

from forge_mcp import ToolError, _meta, tool

UNITY_URL = f"http://127.0.0.1:{int(os.environ.get('FORGE3D_UNITY_PORT', '47824'))}"
NOT_RUNNING = ("Unity bridge unreachable at {url}. Open the Unity project with the Forge3D Bridge package "
               "installed (Package Manager → Add package from git URL → "
               "https://github.com/Sutsikii/forge-3D.git?path=/unity/com.forge3d.bridge).")


class BridgeBusy(Exception):
    pass


def call(command: str, args: dict | None = None, timeout: float = 200) -> dict:
    body = json.dumps({k: v for k, v in (args or {}).items() if v is not None}).encode()
    req = urllib.request.Request(f"{UNITY_URL}/{command}", body, {"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read().decode("utf-8"))
        except ValueError:
            data = {"error": str(exc)}
        if exc.code == 409 and "glTFast" in data.get("error", ""):
            raise BridgeBusy(data["error"])
        raise ToolError(f"Unity: {data.get('error', exc)}")
    except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
        raise ToolError(NOT_RUNNING.format(url=UNITY_URL) + f" ({exc})")


def _wait_ready(seconds: float) -> None:
    """Wait for a package install + domain reload to finish (bridge restarts)."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(3)
        try:
            st = call("status", timeout=10)
        except ToolError:
            continue  # bridge down during the domain reload
        if st.get("gltf") and not st.get("compiling") and not st.get("gltf_installing"):
            return
    raise ToolError("glTFast is still installing in Unity; retry unity_import in a minute.")


VEC = {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3}


@tool("unity_status", "State of the connected Unity Editor: version, project, open scene, glTFast availability.")
def t_status(_: dict) -> dict:
    return call("status", timeout=15)


@tool(
    "unity_scene",
    "Hierarchy of the open Unity scene (names, paths, transforms, components). Paths are used by the other "
    "unity_* tools.",
    {"max_depth": {"type": "integer", "minimum": 0, "maximum": 10, "default": 2}},
)
def t_scene(a: dict) -> dict:
    return call("scene", {"max_depth": a.get("max_depth", 2)})


@tool(
    "unity_import",
    "Import a Forge3D library item (or any GLB/GLTF/OBJ/FBX file) into the Unity project under Assets/ and "
    "place it in the open scene. The model's base rests on `position` unless on_ground=false. glTFast is "
    "installed automatically the first time.",
    {
        "item_id": {"type": "string", "description": "Forge3D library item (see forge_library)."},
        "variant": {"type": "string", "enum": ["textured", "shape"], "default": "textured"},
        "file_path": {"type": "string", "description": "Any model file on disk, instead of item_id."},
        "name": {"type": "string"},
        "folder": {"type": "string", "default": "Assets/Forge3D"},
        "place": {"type": "boolean", "default": True, "description": "Instantiate it in the open scene."},
        "position": VEC, "rotation": VEC,
        "scale": {"type": "number", "description": "Uniform scale."},
        "parent": {"type": "string", "description": "Path of a parent object."},
        "on_ground": {"type": "boolean", "default": True},
    },
)
def t_import(a: dict) -> dict:
    if a.get("item_id"):
        meta = _meta(a["item_id"])
        files = meta.get("available", {})
        variant = a.get("variant", "textured")
        if variant not in files:
            variant = "shape" if "shape" in files else variant
        if variant not in files:
            raise ToolError("This item has no mesh yet")
        source = os.path.join(meta["path"], files[variant]["name"])
        name = a.get("name") or meta.get("name") or a["item_id"]
    elif a.get("file_path"):
        source = os.path.abspath(a["file_path"])
        if not os.path.isfile(source):
            raise ToolError(f"File not found: {source}")
        name = a.get("name")
    else:
        raise ToolError("Give item_id or file_path")
    args = {
        "source": source, "name": name, "folder": a.get("folder"), "place": a.get("place", True),
        "position": a.get("position"), "rotation": a.get("rotation"), "scale": a.get("scale"),
        "parent": a.get("parent"), "on_ground": a.get("on_ground", True),
    }
    try:
        return call("import", args)
    except BridgeBusy:
        _wait_ready(240)
        return call("import", args)


@tool(
    "unity_create",
    "Create an object in the open scene: empty, camera, light (directional), point_light, cube, sphere, "
    "plane, cylinder, capsule or quad. look_at orients it toward a world point.",
    {
        "type": {"type": "string", "enum": ["empty", "camera", "light", "point_light", "cube", "sphere", "plane",
                                            "cylinder", "capsule", "quad"]},
        "name": {"type": "string"}, "position": VEC, "rotation": VEC, "scale": {"type": "number"},
        "parent": {"type": "string"}, "look_at": VEC,
    },
    ["type"],
)
def t_create(a: dict) -> dict:
    return call("create", a)


@tool(
    "unity_transform",
    "Move, rotate (euler degrees) or scale a scene object, by hierarchy path. Local space. Undoable.",
    {"path": {"type": "string"}, "position": VEC, "rotation": VEC,
     "scale": {"anyOf": [{"type": "number"}, VEC]}},
    ["path"],
)
def t_transform(a: dict) -> dict:
    return call("transform", a)


@tool("unity_delete", "Delete a scene object by hierarchy path (undoable in Unity).",
      {"path": {"type": "string"}}, ["path"])
def t_delete(a: dict) -> dict:
    return call("delete", a)


@tool("unity_set_active", "Show or hide a scene object (and its children) by hierarchy path. Undoable.",
      {"path": {"type": "string"}, "active": {"type": "boolean"}}, ["path", "active"])
def t_set_active(a: dict) -> dict:
    return call("set_active", a)


@tool(
    "unity_screenshot",
    "Render the Unity Scene view (default) or the Game camera to an image, to check the result visually. "
    "focus frames an object (Scene view only).",
    {"view": {"type": "string", "enum": ["scene", "game"], "default": "scene"},
     "width": {"type": "integer", "minimum": 64, "maximum": 2048, "default": 960},
     "height": {"type": "integer", "minimum": 64, "maximum": 2048, "default": 540},
     "focus": {"type": "string"}},
)
def t_screenshot(a: dict) -> list:
    r = call("screenshot", a)
    return [{"type": "image", "data": r["png_base64"], "mimeType": "image/png"},
            {"type": "text", "text": f"{r['width']}x{r['height']} {a.get('view', 'scene')} view"}]


@tool("unity_save_scene", "Save the open Unity scene.")
def t_save(_: dict) -> dict:
    return call("save_scene")
