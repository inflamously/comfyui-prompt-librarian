"""Compacting the library file on explicit request."""

import os
import sqlite3

from ...shared.errors import ReadOnlyError, StoreWriteError
from ...shared.library import Library


def compact(lib: Library) -> tuple[int, int]:
    """Run SQLite's planner maintenance and VACUUM; returns bytes before and after.

    Raises:
        ReadOnlyError: The library declares a newer schema.
        StoreWriteError: The file is corrupt, or SQLite failed.
    """
    if lib.readonly():
        raise ReadOnlyError(f"the library at {lib.path} declares a newer schema")
    if lib.corrupt():
        raise StoreWriteError(f"the SQLite library at {lib.path} is unreadable")
    before = os.path.getsize(lib.path) if lib.exists() else 0
    try:
        lib.prepare()
        con = lib.db.connection()  # VACUUM cannot run inside a transaction
        con.execute("PRAGMA optimize")
        con.execute("VACUUM")
    except (OSError, sqlite3.DatabaseError) as exc:
        raise StoreWriteError(f"cannot optimize {lib.path}: {exc}") from exc
    after = os.path.getsize(lib.path) if lib.exists() else 0
    return before, after
