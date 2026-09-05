"""The library envelope stored beside the records: settings, snippets, ignored pairs.

Everything here tolerates malformed input and never raises on read. Library
settings and storage imports both edit it, always inside one write transaction.
"""

import contextlib
import sqlite3
from collections.abc import Iterator
from typing import Any

from .clock import now_iso
from .coerce import as_int, as_str, clamp
from .db import schema
from .library import Library, Write
from .records import VERSION_CAP

DEFAULT_DUPE_THRESHOLD = 0.90
MAX_SNIPPET_NAME_CHARS = 100

Meta = dict[str, Any]


def clean_settings(raw: object) -> dict[str, Any]:
    """Both settings present and in range; unknown keys kept."""
    merged = dict(raw) if isinstance(raw, dict) else {}
    try:
        threshold = float(merged.get("dupe_threshold", DEFAULT_DUPE_THRESHOLD))
    except (TypeError, ValueError):
        threshold = DEFAULT_DUPE_THRESHOLD
    merged["dupe_threshold"] = clamp(threshold, 0.0, 1.0)
    merged["version_cap"] = clamp(
        as_int(merged.get("version_cap", VERSION_CAP), VERSION_CAP), 1, 1000
    )
    return merged


def clean_snippets(raw: object) -> dict[str, dict[str, Any]]:
    """A ``{name: {"body", "updated"}}`` map; bare strings are accepted as bodies."""
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return out
    for key, value in raw.items():
        name = as_str(key).strip()[:MAX_SNIPPET_NAME_CHARS]
        if not name:
            continue
        if isinstance(value, str):
            out[name] = {"body": value, "updated": now_iso()}
        elif isinstance(value, dict):
            item = dict(value)
            item["body"] = as_str(value.get("body", ""))
            item["updated"] = as_str(value.get("updated", "")) or now_iso()
            out[name] = item
    return out


def clean_pairs(raw: object) -> list[list[str]]:
    """Sorted, deduplicated ``[lo, hi]`` id pairs, never a record paired with itself."""
    out: list[list[str]] = []
    if not isinstance(raw, (list, tuple)):
        return out
    for pair in raw:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        a, b = as_str(pair[0]), as_str(pair[1])
        key = sorted((a, b))
        if a and b and a != b and key not in out:
            out.append(key)
    return out


def clean_meta(raw: object) -> Meta:
    """The stored envelope minus ``prompts``; unknown keys (``migrations``) kept.

    Never calls the clock for an absent envelope, so reading it has no side effects.
    """
    meta = dict(raw) if isinstance(raw, dict) else {}
    meta["schema"] = as_int(meta.get("schema", schema.SCHEMA_VERSION), schema.SCHEMA_VERSION)
    meta["updated"] = as_str(meta.get("updated", ""))
    meta["settings"] = clean_settings(meta.get("settings"))
    meta["snippets"] = clean_snippets(meta.get("snippets"))
    meta["ignored"] = clean_pairs(meta.get("ignored"))
    meta.pop("prompts", None)
    return meta


def version_cap(con: sqlite3.Connection) -> int:
    """How many versions a record keeps, from the stored settings."""
    return read(con)["settings"]["version_cap"]


def read(con: sqlite3.Connection) -> Meta:
    """The cleaned envelope, inside the caller's transaction."""
    return clean_meta(schema.read_meta(con))


def load(lib: Library) -> Meta:
    """The cleaned envelope of ``lib``; defaults for a library never written."""
    if not lib.exists():
        return clean_meta(None)
    with lib.read() as con:
        return read(con)


@contextlib.contextmanager
def edit(lib: Library, op: str, ids: tuple[str, ...] = ()) -> Iterator[tuple[Write, Meta]]:
    """One write that edits the envelope and stamps ``updated``.

    Set ``skip`` on the yielded :class:`Write` when nothing changed.
    """
    with lib.write(op) as work:
        meta = read(work.con)
        yield work, meta
        if not work.skip:
            meta["updated"] = now_iso()
            schema.write_meta(work.con, meta)
            work.ids.extend(ids)
