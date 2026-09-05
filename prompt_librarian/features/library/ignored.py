""""Keep both" decisions: near-duplicate pairs the user chose not to merge.

A muted pair stays in duplicate counts and groups; it only annotates matches so
the save dialog does not ask again.
"""

import sqlite3
from typing import Any

from ...shared import meta
from ...shared.coerce import as_str
from ...shared.db import schema
from ...shared.library import Library


def _pair(a: object, b: object) -> list[str]:
    return sorted((as_str(a), as_str(b)))


def ignore_pair(lib: Library, a: str, b: str) -> bool:
    """Mute a pair; ``False`` when it already was.

    Raises:
        ValueError: The ids are missing or the same.
    """
    first, second = as_str(a), as_str(b)
    if not first or not second or first == second:
        raise ValueError("ignore_pair needs two distinct ids")
    key = _pair(first, second)
    with meta.edit(lib, "ignore", (first, second)) as (work, stored):
        work.skip = key in stored["ignored"]
        if not work.skip:
            stored["ignored"].append(key)
    return not work.skip


def unignore_pair(lib: Library, a: str, b: str) -> bool:
    """Forget a decision so the pair is reported again; ``False`` when it was not muted."""
    key = _pair(a, b)
    with meta.edit(lib, "ignore", tuple(key)) as (work, stored):
        work.skip = key not in stored["ignored"]
        stored["ignored"] = [pair for pair in stored["ignored"] if pair != key]
    return not work.skip


def is_ignored(lib: Library, a: str, b: str) -> bool:
    """Whether the (unordered) pair is muted."""
    return _pair(a, b) in meta.load(lib)["ignored"]


def ignored_pairs(lib: Library) -> set[tuple[str, str]]:
    """Every muted pair as ``(lo, hi)``, for O(1) membership."""
    return {(pair[0], pair[1]) for pair in meta.load(lib)["ignored"]}


def forget_deleted(
    con: sqlite3.Connection, pid: str, projection: dict[str, Any] | None, _previous: str | None
) -> None:
    """Library projector: drop muted pairs naming a deleted record, in its transaction."""
    if projection is not None:
        return
    raw = schema.read_meta(con)
    if not raw:
        return
    pairs = meta.clean_pairs(raw.get("ignored"))
    kept = [pair for pair in pairs if pid not in pair]
    if len(kept) != len(pairs):
        raw["ignored"] = kept
        schema.write_meta(con, raw)
