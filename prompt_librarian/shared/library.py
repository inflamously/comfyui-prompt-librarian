"""The open library: one database file, its change bus, and its derived tables.

Every write goes through :meth:`Library.write`: one transaction that bumps the
revision, runs the derived-table writers registered with :meth:`Library.extend`,
and emits one :class:`~.events.Change` after it commits. There is no in-memory
copy of the library; SQLite is read directly and caches key on the revision.
"""

import contextlib
import sqlite3
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from . import corpus
from .db import schema, state
from .db.connection import Database, file_identity
from .errors import ReadOnlyError, StoreWriteError
from .events import Change, EventBus

#: Creates a feature's own tables inside the schema transaction.
Setup = Callable[[sqlite3.Connection], None]
#: Updates a feature's derived rows for one record: ``(con, pid, projection,
#: previous_body)``; ``projection`` is ``None`` when the record was deleted.
Projector = Callable[[sqlite3.Connection, str, dict[str, Any] | None, str | None], None]

_INIT_LOCK = threading.RLock()
#: path -> (file identity, fts5, retired entry columns). DDL runs once per file;
#: repeating it on every operation could race another instance's transaction.
_INITIALIZED: dict[str, tuple[Any, bool, tuple[str, ...]]] = {}


@dataclass
class Write:
    """One write in progress. Record changes are reported through :meth:`touched`."""

    con: sqlite3.Connection
    library: "Library"
    op: str
    ids: list[str] = field(default_factory=list)
    records: dict[str, Any] = field(default_factory=dict)
    bodies_changed: bool = False
    skip: bool = False

    def touched(self, pid: str, record: dict[str, Any] | None, body_changed: bool) -> None:
        """Note that ``pid`` now holds ``record`` (``None``: deleted)."""
        if pid not in self.records:
            self.ids.append(pid)
        self.records[pid] = record
        self.bodies_changed = self.bodies_changed or body_changed


class Library:
    """A library file plus everything a write has to keep consistent with it."""

    def __init__(self, path: str, events: EventBus | None = None) -> None:
        """Open nothing yet: the file is created by the first write."""
        self.db = Database(path)
        self.events = events or EventBus()
        self.fts5 = False
        self.retired_columns: tuple[str, ...] = ()
        self._setups: list[Setup] = []
        self._projectors: list[Projector] = []

    @property
    def path(self) -> str:
        """Absolute path of the library file."""
        return self.db.path

    def extend(self, setup: Setup | None = None, projector: Projector | None = None) -> None:
        """Register a feature's table setup and/or derived-row writer."""
        if setup is not None:
            self._setups.append(setup)
        if projector is not None:
            self._projectors.append(projector)

    def exists(self) -> bool:
        """Whether the library file exists; reads of a missing library are empty."""
        return self.db.exists()

    def prepare(self) -> bool:
        """Create the schema once per file identity. Returns whether FTS5 is available.

        A library written by a newer build is left untouched.
        """
        with _INIT_LOCK:
            cached = _INITIALIZED.get(self.path)
            if cached and cached[0] == file_identity(self.path):
                self.fts5, self.retired_columns = cached[1], cached[2]
                return self.fts5
            con = self.db.connection()
            if schema.newer_schema(con):
                self.fts5 = corpus.has_fts(con)
                return self.fts5
            schema.use_wal(con)
            with self.db.write() as con:
                self.retired_columns = schema.create(con)
                self.fts5 = corpus.create(con)
                for setup in self._setups:
                    setup(con)
            _INITIALIZED[self.path] = (file_identity(self.path), self.fts5, self.retired_columns)
        return self.fts5

    def project(
        self,
        con: sqlite3.Connection,
        pid: str,
        projection: dict[str, Any] | None,
        previous_body: str | None,
    ) -> None:
        """Bring every derived table in line with one record write or delete."""
        if projection is None:
            corpus.delete(con, pid, self.fts5)
        else:
            corpus.write(con, projection, self.fts5)
        for projector in self._projectors:
            projector(con, pid, projection, previous_body)

    @contextlib.contextmanager
    def read(self) -> Iterator[sqlite3.Connection]:
        """A read transaction. Database failures surface as :class:`StoreWriteError`."""
        try:
            self.prepare()
            with self.db.read() as con:
                yield con
        except (OSError, sqlite3.DatabaseError) as exc:
            raise StoreWriteError(f"cannot read {self.path}: {exc}") from exc

    @contextlib.contextmanager
    def write(self, op: str) -> Iterator[Write]:
        """One write: commit, bump the revision, then emit its :class:`Change`.

        Set ``skip`` on the :class:`Write` for a no-op; nothing is bumped or emitted.

        Raises:
            ReadOnlyError: The library declares a newer schema.
            StoreWriteError: SQLite failed; the transaction rolled back.
        """
        try:
            self.prepare()
            with self.db.write() as con:
                if schema.newer_schema(con):
                    raise ReadOnlyError(
                        f"the library at {self.path} declares a schema newer than "
                        f"{schema.SCHEMA_VERSION}; this build will not write to it"
                    )
                work = Write(con, self, op)
                yield work
                if not work.skip:
                    old_rev, new_rev = state.bump(con)
                    state.put(con, "library_schema", schema.SCHEMA_VERSION)
        except (OSError, sqlite3.DatabaseError) as exc:
            raise StoreWriteError(f"cannot write {self.path}: {exc}") from exc
        if not work.skip:
            self.events.emit(
                Change(op, tuple(work.ids), old_rev, new_rev, work.bodies_changed, work.records)
            )

    def revision(self) -> int:
        """The committed revision; 0 for a library never written."""
        if not self.exists():
            return 0
        with self.read() as con:
            return state.revision(con)

    def readonly(self) -> bool:
        """Whether the library declares a schema newer than this build."""
        if not self.exists():
            return False
        with self.read() as con:
            return schema.newer_schema(con)

    def corrupt(self) -> bool:
        """Whether the file fails SQLite's integrity check. Busy is not corrupt."""
        if not self.exists():
            return False
        try:
            con = self.db.connection()
            row = con.execute("PRAGMA quick_check").fetchone()
        except sqlite3.OperationalError:
            return False
        except sqlite3.DatabaseError:
            return True
        return not row or row[0] != "ok"

    def close(self) -> None:
        """Close every connection; the next use reopens."""
        self.db.close()
