"""Smoke test of the runtime. Prints one JSON line prefixed FORGE3D_VERIFY=."""
from __future__ import annotations

import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main() -> None:
    report: dict = {"python": sys.version.split()[0], "errors": {}}
    try:
        import torch

        report["torch"] = torch.__version__
        report["cuda"] = torch.cuda.is_available()
        report["cuda_version"] = torch.version.cuda
        if report["cuda"]:
            report["gpu"] = torch.cuda.get_device_name(0)
    except Exception as exc:
        report["errors"]["torch"] = str(exc)

    from forge_engine import native_status, setup_paths

    try:
        setup_paths()
    except Exception as exc:
        report["errors"]["paths"] = str(exc)

    checks = {
        "shape": "from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline",
        "postprocess": "from hy3dshape.postprocessors import FaceReducer, FloaterRemover",
        "rembg": "import rembg",
        "server": "import fastapi, uvicorn, multipart",
        "rasterizer": "import custom_rasterizer_kernel, custom_rasterizer",
        "inpaint": "from DifferentiableRenderer.mesh_inpaint_processor import meshVerticeInpaint",
        "paint": "from textureGenPipeline import Hunyuan3DPaintPipeline, Hunyuan3DPaintConfig",
        "convert": "from hy3dpaint.convert_utils import create_glb_with_pbr_materials",
        "diffusers": "import diffusers",
    }
    report["imports"] = {}
    for name, stmt in checks.items():
        try:
            exec(stmt, {})
            report["imports"][name] = True
        except Exception as exc:
            report["imports"][name] = False
            report["errors"][name] = "".join(traceback.format_exception_only(type(exc), exc)).strip()[:400]
    # Importing is not enough: a binary built against the wrong tensor types
    # imports fine and only fails when it rasterizes. Run one triangle.
    try:
        import torch
        import custom_rasterizer as cr

        pos = torch.tensor([[[-0.5, -0.5, 0.5, 1.0], [0.5, -0.5, 0.5, 1.0], [0.0, 0.5, 0.5, 1.0]]],
                           device="cuda", dtype=torch.float32)
        tri = torch.tensor([[0, 1, 2]], device="cuda", dtype=torch.int32)
        findices, _bary = cr.rasterize(pos, tri, (64, 64))
        torch.cuda.synchronize()
        if int((findices > 0).sum()) == 0:
            raise RuntimeError("le triangle de test n'a couvert aucun pixel")
        report["imports"]["rasterizer_run"] = True
    except Exception as exc:
        report["imports"]["rasterizer_run"] = False
        report["errors"]["rasterizer_run"] = "".join(traceback.format_exception_only(type(exc), exc)).strip()[:400]
    report["native"] = native_status()
    print("FORGE3D_VERIFY=" + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
