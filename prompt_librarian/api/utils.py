"""Route table, decorators and coercion helpers that default on malformed input."""

import asyncio
import functools
import logging
import traceback
from collections import namedtuple

from .. import app
from ..features import dupes, search
from ..features.library.ignored import ignored_pairs
from ..features.library.settings import read_settings
from .config import _ERROR_MAP, PREFIX

log = logging.getLogger(__name__)

# op is a public operation ID used by generated clients; rename it like a URL.
Spec = namedtuple("Spec", "op summary query body returns")

Route = namedtuple("Route", "method path handler spec")

_web = None            # aiohttp.web, bound on first use
_ROUTES = []           # [Route] — filled by @_route at import


def _get_web():
    """aiohttp's ``web`` module, imported on first use and cached."""
    global _web
    if _web is None:
        from aiohttp import web  # noqa: WPS433 - deliberately lazy
        _web = web
    return _web


def _lib():
    """The current app's library; routes reach it only through here."""
    return app.current().lib


def _rev():
    try:
        return app.current().lib.revision()
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


def _route(method, path, op, returns, summary="", query=None, body=None):
    """Register a route; op/query/body/returns feed OpenAPI only and do not validate requests."""
    def _deco(fn):
        handler = _guard(fn)
        _ROUTES.append(Route(method, PREFIX + path, handler, Spec(
            op=op,
            summary=summary or (fn.__doc__ or "").strip().split("\n")[0],
            query=query,
            body=body,
            returns=returns,
        )))
        return handler
    return _deco


async def _offload(fn, *args, **kwargs):
    """Run ``fn`` on the default executor. Every mutation goes through here."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, functools.partial(fn, *args, **kwargs))


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
            value = read_settings(_lib()).get("dupe_threshold", dupes.DEFAULT_THRESHOLD)
        except Exception:
            value = dupes.DEFAULT_THRESHOLD
    out = _float(value, dupes.DEFAULT_THRESHOLD)
    return min(1.0, max(0.0, out))


def _ignored():
    try:
        return ignored_pairs(_lib())
    except Exception:
        return ()


def _labeller(records=None):
    """Use one revision-keyed index so lists, node faces, and versions share labels."""
    return search.labeller(app.current().search_source, records)


def _labelled(rec):
    """``{prompt, label}``; call inside the write's executor hop (see search.labelled)."""
    return search.labelled(app.current().search_source, rec)
