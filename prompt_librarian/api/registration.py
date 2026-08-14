"""The single entry point: turning the route table into live aiohttp routes.

Importing :mod:`.request` fills ``utils._ROUTES`` — that is all the decorators
do. This module is what the pack root calls to hand that table to a real
``RouteTableDef``, and the only place the store listener that keeps the search
and dedupe caches honest is wired up. Keeping it apart from the handlers means
"what happens at startup?" is one short file, and the handler module stays a
list of features with no bootstrap logic at the bottom of it.
"""

import logging

from ..store import STORE
from .config import PREFIX
from .request import _on_change, handlers
from .utils import _ROUTES, _get_web

log = logging.getLogger(__name__)

_registered = False    # register() is idempotent


def register(routes):
    """Attach every route to an aiohttp ``RouteTableDef``.

    Idempotent, and returns ``{(method, path): handler}`` so the handlers can
    be driven directly in tests without standing up a server.
    """
    global _registered
    _get_web()
    for method, path, handler in _ROUTES:
        getattr(routes, method)(path)(handler)
    if not _registered:
        # Wired once: keeps the search and dedupe caches from growing without
        # bound as the library changes underneath them.
        try:
            STORE.on_change(_on_change)
        except Exception:  # pragma: no cover
            log.debug("[prompt-librarian] on_change wiring failed", exc_info=True)
        _registered = True
    log.info("[prompt-librarian] registered %d routes under %s", len(_ROUTES), PREFIX)
    return handlers()
