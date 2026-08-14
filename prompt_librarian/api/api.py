"""The route table, assembled.

The handlers live in :mod:`.routes`, one module per feature group; the shared
plumbing they are built out of lives below them (:mod:`.utils` for the
mechanics, :mod:`.queries` for the read path, :mod:`.indexing` for the cache
maintenance a write owes). What is left here is the seam between "the handlers
exist" and "aiohttp can be told about them".

Importing :mod:`.routes` is what fills ``utils._ROUTES`` — every ``@_route``
registers as a side effect of its module being imported, so that one import
below is load-bearing rather than decorative, and :mod:`.registration` gets a
complete table simply by importing this module.

``_notify`` websocket events are emitted by the store itself; nothing in the
route layer duplicates them.
"""

from . import routes
from .utils import _ROUTES

__all__ = ["handlers", "routes"]


def handlers():
    """``{(method, path): handler}`` without touching aiohttp or the store."""
    return {(route.method, route.path): route.handler for route in _ROUTES}
