"""Route-table plumbing and request coercion.

Nothing in here knows what any single endpoint *does*. This is the machinery
every handler in :mod:`.request` is built out of:

* :func:`_route` — register a ``(method, path)`` and wrap it in :func:`_guard`.
* :func:`_json` / :func:`_error` — the response envelope, ``rev`` always merged.
* :func:`_offload` — the one way off the event loop.
* ``_str`` / ``_bool`` / ``_int`` / ``_float`` / ``_list`` / ``_opt`` — query
  strings hand back only ``str``, JSON bodies hand back anything at all, and
  the store expects neither; these are the funnel between them. All of them
  are total: they fall back to a default rather than raise, because a
  malformed query parameter is a client typo, not a 500.

Names are underscore-prefixed because they are package-internal — they cross
freely between the three modules here and are not part of what
``api/__init__.py`` re-exports.
"""

import asyncio
import functools
import logging
import traceback

from .. import dedupe
from ..store import STORE
from .config import _ERROR_MAP, PREFIX

log = logging.getLogger(__name__)

_web = None            # aiohttp.web, bound on first use
_ROUTES = []           # [(method, path, handler)] — filled by @_route at import


# --------------------------------------------------------------------------- #
# Plumbing
# --------------------------------------------------------------------------- #

def _get_web():
    """aiohttp's ``web`` module, imported on first use and cached."""
    global _web
    if _web is None:
        from aiohttp import web  # noqa: WPS433 - deliberately lazy
        _web = web
    return _web


def _rev():
    try:
        return STORE.rev()
    except Exception:
        return 0


def _json(payload, status=200):
    """JSON response with ``rev`` merged in."""
    body = dict(payload or {})
    body.setdefault("rev", _rev())
    return _get_web().json_response(body, status=status)


def _error(exc):
    """Map a store exception onto ``(status, code)`` and render it."""
    for kind, status, code in _ERROR_MAP:
        if isinstance(exc, kind):
            return _json({"error": str(exc), "code": code}, status=status)
    return None


def _guard(fn):
    """Catch everything, log the traceback, never 500 the ComfyUI server."""
    @functools.wraps(fn)
    async def _wrapped(request):
        try:
            return await fn(request)
        except Exception as exc:  # noqa: BLE001 - the whole point of the guard
            mapped = _error(exc)
            if mapped is not None:
                return mapped
            log.error("[prompt-librarian] %s failed:\n%s",
                      getattr(fn, "__name__", "handler"), traceback.format_exc())
            return _json({"error": str(exc) or exc.__class__.__name__,
                          "code": "internal"}, status=500)
    return _wrapped


def _route(method, path):
    def _deco(fn):
        handler = _guard(fn)
        _ROUTES.append((method, PREFIX + path, handler))
        return handler
    return _deco


async def _offload(fn, *args, **kwargs):
    """Run ``fn`` on the default executor. Every mutation goes through here."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, functools.partial(fn, *args, **kwargs))


# --------------------------------------------------------------------------- #
# Request coercion — query strings give strings, JSON bodies give real types
# --------------------------------------------------------------------------- #

async def _body(request):
    """The POST body as a dict; a malformed body is an empty one, not a 500."""
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _query(request):
    try:
        return dict(request.rel_url.query)
    except Exception:
        return {}


def _str(value, default=""):
    if value is None:
        return default
    return value if isinstance(value, str) else str(value)


def _bool(value, default=False):
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return _str(value).strip().lower() in ("1", "true", "yes", "on")


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _list(value):
    """A list of non-empty strings from a JSON list or a comma-separated string."""
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    try:
        return [_str(item).strip() for item in value if _str(item).strip()]
    except TypeError:
        return []


def _opt(data, key):
    """``data[key]`` when present, else ``None`` — for partial updates."""
    return data.get(key, None)


def _threshold(value=None):
    """The similarity threshold: explicit, else the persisted setting, else 0.90."""
    if value is None or value == "":
        try:
            value = STORE.settings().get("dupe_threshold", dedupe.DEFAULT_THRESHOLD)
        except Exception:
            value = dedupe.DEFAULT_THRESHOLD
    out = _float(value, dedupe.DEFAULT_THRESHOLD)
    return min(1.0, max(0.0, out))


def _ignored():
    try:
        return STORE.ignored_pairs()
    except Exception:
        return ()
