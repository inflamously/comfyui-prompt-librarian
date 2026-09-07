"""Optional store defaults and snippet lookup; all storage access is lazy."""

import os

# Keep the store optional so standalone resolution needs no ComfyUI.
try:
    from ..store import STORE as _STORE
    from ..store import wildcards_dir as _store_wildcards_dir
except Exception:  # pragma: no cover - no store at all (bare unit use)
    _STORE = None
    _store_wildcards_dir = None


def _default_wildcards_dir():
    """Where ``__name__`` files live. Resolved lazily -- never at import time."""
    if _STORE is not None:
        try:
            return _STORE.wildcards_dir()
        except Exception:
            pass
    if _store_wildcards_dir is not None:
        try:
            return _store_wildcards_dir()
        except Exception:
            pass
    # Preserve the pre-package fallback: prompt_librarian/wildcards.
    return os.path.dirname(os.path.abspath(__file__))


def _snippet_body(source, name):
    """Look ``name`` up in ``source``; ``None`` when it does not exist.

    ``source`` may be a dict of ``{name: body}``, a dict of the store's
    ``{name: {"body": ...}}`` shape, or any callable taking a name.
    """
    if source is None:
        return None
    if callable(source):
        try:
            value = source(name)
        except Exception:
            return None
    else:
        try:
            value = source[name]
        except (KeyError, TypeError, IndexError):
            return None
    if value is None:
        return None
    if isinstance(value, dict):
        return str(value.get("body", ""))
    return str(value)


def _default_snippets():
    if _STORE is None:
        return {}
    try:
        return _STORE.snippets()
    except Exception:
        return {}
