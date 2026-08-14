"""Prompt Library domain — the original ``PromptLibrary`` node and its store.

Everything this node needs lives in :mod:`prompt_store.node`: the
``prompts.json`` helpers and the node class itself. The package re-exports the
names the pack root binds its ``/prompt_library/*`` routes to, so callers never
have to reach past the domain boundary into a submodule.

This domain shares nothing with :mod:`prompt_librarian` — separate store file,
separate routes, separate web assets.
"""

from .node import (
    EMPTY_LABEL,
    PromptLibrary,
    _add_prompt,
    _category_names,
    _load_prompts,
    _save_prompts,
    _save_target,
)

__all__ = [
    "EMPTY_LABEL",
    "PromptLibrary",
    "_add_prompt",
    "_category_names",
    "_load_prompts",
    "_save_prompts",
    "_save_target",
]
