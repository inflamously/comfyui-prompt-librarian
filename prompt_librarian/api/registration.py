"""Attach decorated routes. Cache upkeep subscribes to the library, not here."""

import logging

from .api import handlers
from .config import PREFIX
from .utils import _ROUTES, _get_web

log = logging.getLogger(__name__)


def register(routes):
    """Attach every route to an aiohttp ``RouteTableDef``.

    Idempotent, and returns ``{(method, path): handler}`` so the handlers can
    be driven directly in tests without standing up a server.
    """
    _get_web()
    for route in _ROUTES:
        getattr(routes, route.method)(route.path)(route.handler)
    log.info("[prompt-librarian] registered %d routes under %s", len(_ROUTES), PREFIX)
    return handlers()
