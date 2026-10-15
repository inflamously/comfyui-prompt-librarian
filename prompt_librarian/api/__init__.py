"""HTTP API: route decorators assemble the table, register() attaches it to aiohttp."""

# OpenAPI generation is optional; never import it here.
from . import api, config, queries, registration, routes, schemas, utils
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
    "queries",
    "register",
    "registration",
    "routes",
    "schemas",
    "utils",
]
