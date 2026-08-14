"""Prompt Librarian domain — node, store, search, dedupe, wildcards and routes.

Module layout, highest layer first (each may import the ones below it, never
the ones above — enforced by the import-linter contract in ``pyproject.toml``):

``node``
    The ``PromptLibrarian`` ComfyUI node.
``api``
    The ``/prompt_librarian/*`` aiohttp routes — a package of its own:
    ``config`` (constants), ``utils`` (route table and coercion), ``api``
    (one function per feature), ``registration`` (the startup wiring) and
    ``openapi`` (the route table as a spec, loaded only by the script that
    emits it). Registered by the pack root via
    :func:`prompt_librarian.api.register`; importing this package does not
    touch aiohttp.
``wildcards``
    ``{a|b}`` / ``__file__`` / ``[[snippet]]`` expansion.
``dedupe``
    Near-duplicate detection and diffing.
``search``
    Normalisation, tokenising, ranking.
``store``
    ``library.json`` persistence — the bottom of the stack.

Only the node is re-exported here; the pack root imports ``api`` explicitly,
inside its own guard, so a failure in the route stack cannot take the node down
with it.
"""

from .node import PromptLibrarian

__all__ = ["PromptLibrarian"]
