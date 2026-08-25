"""Paths, scalars and field normalization — the helpers with no state at all.

Everything here is a pure function of its arguments (or, for the path helpers,
of ComfyUI's user directory). Nothing in this module holds a library or opens a
file.

Paths are resolved lazily, *inside* the functions, never at import time:
ComfyUI sets its user directory up after our modules are imported.
"""

import logging
import os
import re
import uuid
from datetime import datetime, timezone

from .types import MAX_BODY_CHARS, MAX_TAG_CHARS, MAX_TAGS, BodyTooLargeError

try:  # ComfyUI is optional: the module must import headless for tests/tools.
    import folder_paths
except ImportError:  # pragma: no cover - exercised by the test stub instead
    folder_paths = None

log = logging.getLogger("prompt-librarian")

_WS_RE = re.compile(r"\s+", re.UNICODE)
# Used only when ComfyUI's `folder_paths` is unavailable (headless tools, tests).
# Tests override this, or hand a store an explicit `path=`. It deliberately
# resolves to `prompt_librarian/_user`, not `prompt_librarian/store/_user`: the
# directory predates this package split and existing scratch dirs point at it.
_FALLBACK_USER_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "_user"
)


# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #

def user_dir():
    """ComfyUI's user directory, or ``_FALLBACK_USER_DIR`` when running headless."""
    if folder_paths is not None:
        try:
            return folder_paths.get_user_directory()
        except Exception:  # a broken/partial stub must not break the store
            log.debug("folder_paths.get_user_directory() failed", exc_info=True)
    return _FALLBACK_USER_DIR


def store_dir():
    """Directory holding the SQLite library and wildcard files."""
    return os.path.join(user_dir(), "default", "prompt-librarian")


def database_path():
    """Absolute path of the authoritative SQLite library."""
    return os.path.join(store_dir(), "library.sqlite3")


def wildcards_dir():
    """Absolute path of the ``__wildcard__`` text-file directory."""
    return os.path.join(store_dir(), "wildcards")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def now_iso():
    """Current UTC time as ``2026-08-13T18:20:00Z``.

    Second precision with a literal ``Z``: these strings are compared and sorted
    lexicographically all over the search/merge code, which only works if every
    timestamp in the library has exactly the same shape.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id():
    """A fresh stable record id; identical prompt bodies may coexist."""
    return uuid.uuid4().hex


def preview_of(text, chars=160):
    """One-line, length-capped excerpt of ``text`` for list rows and version lists."""
    flat = _WS_RE.sub(" ", str(text or "")).strip()
    return flat[:chars]


def _as_str(value, default=""):
    if isinstance(value, str):
        return value
    if value is None:
        return default
    return str(value)


def _as_int(value, default=0):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _clamp(value, low, high):
    return low if value < low else (high if value > high else value)


def clean_tag(tag):
    """Normalize one tag: casefolded, whitespace collapsed to ``-``, length capped.

    ``casefold()`` rather than ``lower()`` so ``ß``/``SS`` and Turkish dotted I
    behave; the same normalization is applied to every tag query, so filters and
    stored tags can never disagree.
    """
    text = _WS_RE.sub("-", _as_str(tag).strip()).casefold()
    return text[:MAX_TAG_CHARS]


def clean_tags(tags):
    """Normalize a tag list: cleaned, empties dropped, deduped in order, ≤32 kept."""
    if isinstance(tags, str):
        tags = list(re.split(r"[,\n]", tags))
    if not isinstance(tags, (list, tuple, set, frozenset)):
        return []
    out = []
    seen = set()
    for raw in tags:
        tag = clean_tag(raw)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
        if len(out) >= MAX_TAGS:
            break
    return out


def clean_body(body):
    """Validate a body. Raises :class:`~.types.BodyTooLargeError` — never truncates."""
    text = _as_str(body)
    if len(text) > MAX_BODY_CHARS:
        raise BodyTooLargeError(
            f"body is {len(text)} characters, the limit is {MAX_BODY_CHARS}"
        )
    return text


def _min_ts(a, b):
    """Lexicographic min of two ISO-8601 ``Z`` stamps, treating ``""`` as absent."""
    if not a:
        return b or ""
    if not b:
        return a
    return a if a <= b else b


def _max_ts(a, b):
    """Lexicographic max of two ISO-8601 ``Z`` stamps, treating ``""`` as absent."""
    if not a:
        return b or ""
    if not b:
        return a
    return a if a >= b else b
