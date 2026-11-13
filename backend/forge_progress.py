"""Progress reporting and cooperative cancellation.

Hunyuan3D and diffusers report their inner loops through tqdm. We swap the
`tqdm` name in those modules for ProgressBar, which forwards every step to the
job currently running on the GPU worker and raises Cancelled when the user
asked to stop. This gives real step-level progress without forking upstream.
"""
from __future__ import annotations

import sys
import threading
from typing import Any, Iterable, Optional

_state = threading.local()
_global = {"job": None}


class Cancelled(Exception):
    """Raised inside a pipeline loop when the running job was cancelled."""


def set_job(job: Any) -> None:
    _global["job"] = job


def get_job() -> Any:
    return _global["job"]


def check_cancel() -> None:
    job = get_job()
    if job is not None and getattr(job, "cancel_requested", False):
        raise Cancelled()


def _report(bar: "ProgressBar") -> None:
    job = get_job()
    if job is not None:
        job.on_substep(bar.desc, bar.n, bar.total)


class ProgressBar:
    """Minimal drop-in replacement for the tqdm API used by the pipelines."""

    _lock = threading.RLock()

    def __init__(self, iterable: Optional[Iterable] = None, desc: Optional[str] = None,
                 total: Optional[float] = None, disable: bool = False, *args: Any, **kwargs: Any) -> None:
        self.iterable = iterable
        self.desc = (desc or "").rstrip(": ")
        if total is None and iterable is not None:
            try:
                total = len(iterable)  # type: ignore[arg-type]
            except Exception:
                total = None
        self.total = total
        self.n = 0
        self.disable = disable

    def __iter__(self):
        if self.iterable is None:
            return
        _report(self)
        for item in self.iterable:
            check_cancel()
            yield item
            self.n += 1
            _report(self)

    def __len__(self) -> int:
        return int(self.total or 0)

    def __enter__(self) -> "ProgressBar":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def update(self, n: float = 1) -> None:
        check_cancel()
        self.n += n
        _report(self)

    def reset(self, total: Optional[float] = None) -> None:
        self.n = 0
        if total is not None:
            self.total = total

    def set_description(self, desc: Optional[str] = None, refresh: bool = True) -> None:
        self.desc = (desc or "").rstrip(": ")

    def set_description_str(self, desc: Optional[str] = None, refresh: bool = True) -> None:
        self.set_description(desc)

    def set_postfix(self, *args: Any, **kwargs: Any) -> None:
        pass

    def set_postfix_str(self, *args: Any, **kwargs: Any) -> None:
        pass

    def refresh(self, *args: Any, **kwargs: Any) -> None:
        pass

    def clear(self, *args: Any, **kwargs: Any) -> None:
        pass

    def close(self) -> None:
        pass

    def unpause(self) -> None:
        pass

    @staticmethod
    def write(s: str, *args: Any, **kwargs: Any) -> None:
        print(s)

    @classmethod
    def get_lock(cls):
        return cls._lock

    @classmethod
    def set_lock(cls, lock) -> None:
        cls._lock = lock


PATCH_PREFIXES = (
    "hy3dshape",
    "hy3dpaint",
    "textureGenPipeline",
    "utils",
    "DifferentiableRenderer",
    "hunyuanpaintpbr",
    "diffusers",
    "diffusers_modules",
    "custom_rasterizer",
)


def patch_tqdm() -> int:
    """Replace tqdm in already-imported pipeline modules. Returns patch count."""
    import tqdm as tq
    import tqdm.std

    originals = {tq.tqdm, tqdm.std.tqdm}
    try:
        import tqdm.auto

        originals.add(tqdm.auto.tqdm)
    except Exception:
        pass
    count = 0
    for name, mod in list(sys.modules.items()):
        if mod is None or not name.startswith(PATCH_PREFIXES):
            continue
        try:
            current = getattr(mod, "tqdm", None)
        except Exception:
            continue
        try:
            if current in originals:
                setattr(mod, "tqdm", ProgressBar)
                count += 1
        except TypeError:
            continue
    return count
