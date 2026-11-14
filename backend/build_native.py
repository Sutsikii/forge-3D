"""Build Hunyuan3D-Paint's native extensions in place (no pip install).

    python build_native.py rasterizer <repo>   # CUDA, needs nvcc + MSVC
    python build_native.py inpaint <repo>      # C++/pybind11, needs MSVC

The Tauri shell runs this inside a vcvars64 environment. Outputs land next to
the sources, which the backend puts on sys.path.
"""
from __future__ import annotations

import os
import sys


def build_rasterizer(repo: str) -> None:
    from setuptools import setup
    from torch.utils.cpp_extension import BuildExtension, CUDAExtension

    root = os.path.join(repo, "hy3dpaint", "custom_rasterizer")
    os.chdir(root)
    # Upstream ships Windows-safe sources (int64_t instead of unsigned long long).
    src = "lib/custom_rasterizer_kernel_for_windows" if os.name == "nt" else "lib/custom_rasterizer_kernel"
    ext = CUDAExtension(
        "custom_rasterizer_kernel",
        [f"{src}/rasterizer.cpp", f"{src}/grid_neighbor.cpp", f"{src}/rasterizer_gpu.cu"],
    )
    setup(name="custom_rasterizer_kernel", version="0.1", ext_modules=[ext],
          cmdclass={"build_ext": BuildExtension.with_options(use_ninja=True)},
          script_args=["build_ext", "--inplace"])


def build_inpaint(repo: str) -> None:
    import pybind11
    from setuptools import Extension, setup

    root = os.path.join(repo, "hy3dpaint", "DifferentiableRenderer")
    os.chdir(root)
    args = ["/O2", "/std:c++17", "/EHsc"] if os.name == "nt" else ["-O3", "-std=c++11", "-fPIC"]
    ext = Extension("mesh_inpaint_processor", ["mesh_inpaint_processor.cpp"],
                    include_dirs=[pybind11.get_include()], language="c++", extra_compile_args=args)
    setup(name="mesh_inpaint_processor", version="0.1", ext_modules=[ext],
          script_args=["build_ext", "--inplace"])


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("rasterizer", "inpaint"):
        print(__doc__)
        sys.exit(2)
    target, repo_dir = sys.argv[1], os.path.abspath(sys.argv[2])
    (build_rasterizer if target == "rasterizer" else build_inpaint)(repo_dir)
    print(f"FORGE3D_BUILD_OK={target}", flush=True)
    # setuptools/MSVC can leave stdio in a state where interpreter shutdown
    # fails to flush (exit code 120) even though the build succeeded.
    os._exit(0)
