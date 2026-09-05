"""The ``state`` key/value table, and the library revision kept in it.

The revision rises by one per committed write. Caches key on it, which is what
makes a write from another process visible to this one.
"""

import sqlite3

from ..coerce import as_int


def get(con: sqlite3.Connection, key: str) -> str | None:
    """One state value, or ``None``."""
    row = con.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    return row[0] if row else None


def put(con: sqlite3.Connection, key: str, value: object) -> None:
    """Set one state value."""
    con.execute(
        "INSERT INTO state(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def revision(con: sqlite3.Connection) -> int:
    """The current library revision; 0 for a library never written."""
    return as_int(get(con, "revision"), 0)


def bump(con: sqlite3.Connection) -> tuple[int, int]:
    """Advance the revision inside the caller's write transaction.

    Returns ``(previous, new)``. Read under the write lock, so ``previous`` is
    exactly the revision this write replaced.
    """
    previous = revision(con)
    put(con, "revision", previous + 1)
    return previous, previous + 1
