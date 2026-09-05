"""Turn ComfyUI's ``{filename, subfolder, type}`` image reference into a safe path."""

import logging
import os
from collections.abc import Mapping

try:  # ComfyUI is optional: the module must import headless for tests and tools.
    import folder_paths
except ImportError:  # pragma: no cover - exercised by the test stub instead
    folder_paths = None

log = logging.getLogger("prompt-librarian")

#: ComfyUI's image ``type`` -> the ``folder_paths`` getter for its directory.
KINDS = {
    "output": "get_output_directory",
    "input": "get_input_directory",
    "temp": "get_temp_directory",
}


def comfy_roots() -> dict[str, str]:
    """The image directories ComfyUI reports; missing ones are left out."""
    roots = {}
    for kind, getter in KINDS.items():
        try:
            roots[kind] = getattr(folder_paths, getter)()
        except Exception:  # headless, or a stub without the getter
            log.debug("folder_paths.%s() unavailable", getter, exc_info=True)
    return roots


def resolve_source(
    filename: str, subfolder: str = "", kind: str = "output",
    roots: Mapping[str, str] | None = None,
) -> str:
    """The absolute path of an image ComfyUI produced, confined to its directory.

    Args:
        filename: The image's file name.
        subfolder: Its subfolder inside the directory, as ComfyUI reports it.
        kind: ``output``, ``input`` or ``temp``.
        roots: ``{kind: directory}``; defaults to :func:`comfy_roots`.

    Raises:
        ValueError: Unknown kind, empty name, or a path that leaves the directory.
    """
    root = (comfy_roots() if roots is None else roots).get(kind or "output")
    if not root:
        raise ValueError(f"unknown image type: {kind!r}")
    if not filename:
        raise ValueError("filename is empty")
    base = os.path.realpath(root)
    path = os.path.realpath(os.path.join(base, subfolder or "", filename))
    if os.path.commonpath([base, path]) != base or path == base:
        raise ValueError("image path leaves the ComfyUI directory")
    return path
