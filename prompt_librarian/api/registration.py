"""Attach decorated routes and wire cache invalidation once at startup."""

import logging

from ..store import STORE
from .api import handlers
from .config import PREFIX
from .indexing import _on_change
from .utils import _ROUTES, _get_web

log = logging.getLogger(__name__)

_registered = False


def register(routes):
    """Attach every route to an aiohttp ``RouteTableDef``.

    Idempotent, and returns ``{(method, path): handler}`` so the handlers can
    be driven directly in tests without standing up a server.
    """
    global _registered
    _get_web()
    for route in _ROUTES:
        getattr(routes, route.method)(route.path)(route.handler)
    if not _registered:
        try:
            STORE.on_change(_on_change)
        except Exception:  # pragma: no cover
            log.debug("[prompt-librarian] on_change wiring failed", exc_info=True)
        _registered = True
    log.info("[prompt-librarian] registered %d routes under %s", len(_ROUTES), PREFIX)
    return handlers()
