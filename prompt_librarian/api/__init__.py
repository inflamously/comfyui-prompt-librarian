"""Route decorators assemble the table; register() attaches it to aiohttp.
Keep expensive scans and writes off the event loop. Responses include rev,
and store change events are emitted by the store, not the handlers.
OpenAPI generation stays optional and must not be imported here.
"""

from . import api, config, indexing, queries, registration, routes, schemas, utils
from .api import handlers
from .config import BULK_QUERY_LIMIT, CAPABILITIES, PREFIX
from .registration import register

__all__ = [
    "BULK_QUERY_LIMIT",
    "CAPABILITIES",
    "PREFIX",
    "api",
    "config",
    "handlers",
    "indexing",
    "queries",
    "register",
    "registration",
    "routes",
    "schemas",
    "utils",
]
