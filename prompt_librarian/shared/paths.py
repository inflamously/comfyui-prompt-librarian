"""Library locations, resolved lazily: ComfyUI configures its user directory after import."""

import logging
import os

try:  # ComfyUI is optional: the module must import headless for tests and tools.
    import folder_paths
except ImportError:  # pragma: no cover - exercised by the test stub instead
    folder_paths = None

log = logging.getLogger("prompt-librarian")

# Headless fallback; tests and the dev tool pin this, or pass an explicit store path.
_FALLBACK_USER_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_user"
)


def user_dir() -> str:
    """ComfyUI's user directory, or ``_FALLBACK_USER_DIR`` when running headless."""
    if folder_paths is not None:
        try:
            return folder_paths.get_user_directory()
        except Exception:  # a broken/partial stub must not break the library
            log.debug("folder_paths.get_user_directory() failed", exc_info=True)
    return _FALLBACK_USER_DIR


def store_dir() -> str:
    """Directory holding the SQLite library and wildcard files."""
    return os.path.join(user_dir(), "default", "prompt-librarian")


def database_path() -> str:
    """Absolute path of the authoritative SQLite library."""
    return os.path.join(store_dir(), "library.sqlite3")


def wildcards_dir() -> str:
    """Absolute path of the ``__wildcard__`` text-file directory."""
    return os.path.join(store_dir(), "wildcards")
