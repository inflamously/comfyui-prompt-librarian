"""Reading prompt records. A library never written reads as empty."""

from collections.abc import Iterable

from ...shared import entries
from ...shared.library import Library
from ...shared.records import Record


def get_prompt(lib: Library, pid: str) -> Record | None:
    """One complete record, or ``None`` when the id is unknown."""
    if not lib.exists():
        return None
    with lib.read() as con:
        return entries.get(con, pid)


def get_prompts(lib: Library, ids: Iterable[str]) -> dict[str, Record]:
    """``{id: record}`` for the ids that exist."""
    if not lib.exists():
        return {}
    with lib.read() as con:
        return {rec["id"]: rec for rec in entries.get_many(con, list(ids))}


def all_prompts(lib: Library) -> list[Record]:
    """Every complete record, in creation order."""
    if not lib.exists():
        return []
    with lib.read() as con:
        return entries.get_many(con, entries.ids(con))


def prompt_ids(lib: Library) -> list[str]:
    """Every record id, in creation order."""
    if not lib.exists():
        return []
    with lib.read() as con:
        return entries.ids(con)


def count_prompts(lib: Library) -> int:
    """Number of records."""
    if not lib.exists():
        return 0
    with lib.read() as con:
        return entries.count(con)
