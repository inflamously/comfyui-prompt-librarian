"""aiohttp routes for the Prompt Librarian — ``/prompt_librarian/*``.

:func:`register` is the single entry point; the pack root's ``__init__.py``
calls it from its own isolated ``try/except`` so a failure here can never take
down the old node's routes.

Module layout
-------------

``config``
    Constants only: the URL prefix, the capability probe the frontend reads on
    startup, the bulk-query cap, and the exception -> ``(status, code)`` table.
``utils``
    The route table and everything mechanical — the guard, the JSON envelope,
    the executor hop, and the coercion helpers that turn query strings and
    JSON bodies into the types the store expects.
``request``
    One function per feature: the handlers, plus the index maintenance and
    search plumbing they share.
``registration``
    :func:`register` alone — the startup wiring, kept out of the handler module
    so the two read as separate concerns.

Only ``config`` may not import its siblings; ``utils`` imports ``config``,
``request`` imports both, and ``registration`` sits on top of all three.
Underscore-prefixed names cross these modules freely — the underscore marks
them package-internal, not module-private, and nothing underscored is
re-exported here.

Conventions, all of them deliberate
-----------------------------------

* **Every read is GET, every write is POST.** No PATCH/DELETE verbs and no path
  parameters — that matches the existing pack's style and stays compatible with
  ComfyUI's ``/api`` prefix rewriting, which only reliably preserves the path
  when there is nothing to rewrite.
* **Every handler is wrapped in** ``utils._guard``, which catches ``Exception``,
  logs the traceback and returns ``500 {"error", "code"}``. A backend bug must
  degrade the panel, never take down the ComfyUI server.
* **Store exceptions map to codes** (see ``config._ERROR_MAP``) so the frontend
  can branch on ``code`` instead of parsing prose.
* **Every response merges** ``{"rev": STORE.rev()}``, including errors, so a
  client that hits one can still tell whether its view is stale.
* **Event-loop discipline.** Anything that serializes JSON or scans every record
  goes through ``utils._offload``; dict/index lookups run inline. Concretely:
  all mutations and ``/dupes/all`` are offloaded; ``prompt``, ``search``,
  ``taxonomy``, ``versions`` and the one-vs-N ``/dupes`` run inline.
* **aiohttp is imported on first use**, never at module import time, so the
  tests can import this package in an environment without it.

``_notify`` websocket events are emitted by the store itself; nothing here
duplicates them.
"""

from . import config, registration, request, utils
from .config import BULK_QUERY_LIMIT, CAPABILITIES, PREFIX
from .registration import register
from .request import handlers

__all__ = [
    "BULK_QUERY_LIMIT",
    "CAPABILITIES",
    "PREFIX",
    "config",
    "handlers",
    "register",
    "registration",
    "request",
    "utils",
]
