"""The library file's health, and when it is worth compacting."""

import os
import sqlite3
from typing import Any

from ...shared import entries
from ...shared.errors import StoreWriteError
from ...shared.library import Library
from .migrate import pending_sources

#: Compacting is suggested from this size on, once a fifth of it is free pages.
VACUUM_MIN_BYTES = 8 * 1024 * 1024


def health(lib: Library) -> dict[str, Any]:
    """Integrity state, FTS5 availability, size and reclaimable bytes."""
    if not lib.exists():
        return {"state": "new", "fts5": False, "bytes": 0, "reclaimable_bytes": 0}
    try:
        with lib.read() as con:
            quick = con.execute("PRAGMA quick_check").fetchone()
            page_size = con.execute("PRAGMA page_size").fetchone()[0]
            free_pages = con.execute("PRAGMA freelist_count").fetchone()[0]
    except (OSError, sqlite3.DatabaseError, StoreWriteError):
        size = file_size(lib.path)
        return {"state": "error", "fts5": False, "bytes": size, "reclaimable_bytes": 0}
    return {
        "state": "ready" if quick and quick[0] == "ok" else "error",
        "fts5": lib.fts5,
        "bytes": file_size(lib.path),
        "reclaimable_bytes": int(page_size) * int(free_pages),
    }


def should_compact(database_bytes: int, reclaimable_bytes: int) -> bool:
    """Whether VACUUM would pay off."""
    return database_bytes >= VACUUM_MIN_BYTES and reclaimable_bytes > database_bytes // 5


def file_size(path: str) -> int:
    """Size of ``path`` in bytes; 0 when it is missing."""
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def storage_status(lib: Library, legacy_sources: list[str]) -> dict[str, Any]:
    """Everything the storage panel shows: size, health, and pending legacy files."""
    state = health(lib)
    try:
        sources = pending_sources(lib, legacy_sources)
    except StoreWriteError:
        sources = []
    return {
        "database_bytes": state["bytes"],
        "reclaimable_bytes": state["reclaimable_bytes"],
        "records": _count(lib),
        "should_compact": should_compact(state["bytes"], state["reclaimable_bytes"]),
        "index": {"state": state["state"], "fts5": bool(state["fts5"])},
        "legacy": {
            "available": bool(sources),
            "bytes": sum(file_size(source) for source in sources),
            "sources": [os.path.basename(source) for source in sources],
        },
    }


def _count(lib: Library) -> int:
    if not lib.exists():
        return 0
    try:
        with lib.read() as con:
            return entries.count(con)
    except StoreWriteError:
        return 0
