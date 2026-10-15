"""Import routes so their decorators populate utils._ROUTES."""

from . import routes
from .utils import _ROUTES

__all__ = ["handlers", "routes"]


def handlers():
    """``{(method, path): handler}`` without touching aiohttp or the store."""
    return {(route.method, route.path): route.handler for route in _ROUTES}
