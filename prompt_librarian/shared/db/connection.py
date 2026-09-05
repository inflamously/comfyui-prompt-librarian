"""One SQLite file, one reused connection per thread.

Opening a connection costs more than most queries the library runs, so each
thread keeps its own. Connections run in autocommit mode; :meth:`Database.read`
and :meth:`Database.write` add the transaction, so a multi-query read sees one
snapshot and a write holds the lock from its first statement.
"""

import contextlib
import os
import sqlite3
import threading
from collections.abc import Iterator

BUSY_TIMEOUT_MS = 10000


def file_identity(path: str) -> tuple[int, int] | None:
    """``(device, inode)`` of ``path``, or ``None`` when it does not exist."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return stat.st_dev, stat.st_ino


class Database:
    """Connections to one library file, reopened when the file is replaced."""

    def __init__(self, path: str) -> None:
        """Remember ``path``; nothing is opened until the first query."""
        self.path = os.path.abspath(path)
        self._local = threading.local()
        self._lock = threading.Lock()
        self._opened: list[sqlite3.Connection] = []

    def exists(self) -> bool:
        """Whether the library file exists (opening a connection would create it)."""
        return os.path.exists(self.path)

    def connection(self) -> sqlite3.Connection:
        """This thread's connection, opened on first use and reused after."""
        local = self._local
        con = getattr(local, "con", None)
        if con is not None and local.identity == file_identity(self.path):
            return con
        if con is not None:
            self._discard(con)
        con = self._open()
        local.con, local.identity = con, file_identity(self.path)
        return con

    def _open(self) -> sqlite3.Connection:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        # check_same_thread=False only so close() may run from any thread; each
        # connection is otherwise used by the thread that opened it.
        con = sqlite3.connect(
            self.path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None, check_same_thread=False
        )
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        con.execute("PRAGMA synchronous=NORMAL")
        with self._lock:
            self._opened.append(con)
        return con

    def _discard(self, con: sqlite3.Connection) -> None:
        with self._lock:
            if con in self._opened:
                self._opened.remove(con)
        with contextlib.suppress(sqlite3.Error):
            con.close()

    @contextlib.contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        """A connection inside a read transaction: every query sees one snapshot."""
        with self._transaction("BEGIN") as con:
            yield con

    @contextlib.contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """A connection holding the write lock; commits on success, rolls back on error."""
        with self._transaction("BEGIN IMMEDIATE") as con:
            yield con

    @contextlib.contextmanager
    def _transaction(self, begin: str) -> Iterator[sqlite3.Connection]:
        con = self.connection()
        if con.in_transaction:  # nested: join the outer transaction
            yield con
            return
        con.execute(begin)
        try:
            yield con
        except BaseException:
            con.execute("ROLLBACK")
            raise
        con.execute("COMMIT")

    def close(self) -> None:
        """Close every connection this object opened, from any thread."""
        with self._lock:
            opened, self._opened = self._opened, []
            self._local = threading.local()
        for con in opened:
            with contextlib.suppress(sqlite3.Error):
                con.close()
