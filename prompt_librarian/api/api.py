"""Import routes to populate utils._ROUTES through decorator side effects.
Store notifications are emitted by the store, not this route layer.
"""

from . import routes
from .utils import _ROUTES

__all__ = ["handlers", "routes"]


def handlers():
    """``{(method, path): handler}`` without touching aiohttp or the store."""
    return {(route.method, route.path): route.handler for route in _ROUTES}
