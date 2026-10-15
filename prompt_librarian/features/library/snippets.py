"""Named ``[[snippets]]`` that prompts and wildcards expand."""

import copy
from typing import Any

from ...shared import meta
from ...shared.clock import now_iso
from ...shared.coerce import as_str
from ...shared.errors import NotFoundError
from ...shared.library import Library
from ...shared.records import clean_body


def list_snippets(lib: Library) -> dict[str, dict[str, Any]]:
    """Every snippet as ``{name: {"body", "updated"}}``."""
    return copy.deepcopy(meta.load(lib)["snippets"])


def get_snippet(lib: Library, name: str) -> str | None:
    """One snippet's body, or ``None``."""
    entry = meta.load(lib)["snippets"].get(as_str(name).strip())
    return entry.get("body", "") if isinstance(entry, dict) else None


def set_snippet(lib: Library, name: str, body: str) -> dict[str, Any]:
    """Create or replace a snippet; returns the stored entry."""
    key = as_str(name).strip()[: meta.MAX_SNIPPET_NAME_CHARS]
    if not key:
        raise ValueError("snippet name is empty")
    entry = {"body": clean_body(body), "updated": now_iso()}
    with meta.edit(lib, "snippet") as (_work, stored):
        stored["snippets"][key] = entry
    return dict(entry)


def delete_snippet(lib: Library, name: str) -> None:
    """Delete a snippet."""
    key = as_str(name).strip()
    with meta.edit(lib, "snippet") as (work, stored):
        if key not in stored["snippets"]:
            work.skip = True
            raise NotFoundError(f"no snippet named {key!r}")
        del stored["snippets"][key]


def edit_snippet(lib: Library, op: str, name: str, body: str = "") -> dict[str, dict[str, Any]]:
    """Apply one ``set`` or ``delete`` and return every snippet afterwards."""
    op = as_str(op or "set").strip().lower()
    if op == "set":
        set_snippet(lib, name, body)
    elif op == "delete":
        delete_snippet(lib, name)
    else:
        raise ValueError(f"unknown snippet op {op!r}")
    return list_snippets(lib)
