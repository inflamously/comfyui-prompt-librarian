"""Dupes' view of a library: candidate records and projections read from SQLite."""

from typing import Any

from ...shared import corpus
from ...shared.errors import StoreWriteError
from ...shared.library import Library
from . import queries


class LibraryDupeSource:
    """What the similarity functions read from a library on disk."""

    def __init__(self, lib: Library) -> None:
        """Wrap ``lib``; nothing is read until asked."""
        self.lib = lib

    def revision(self) -> int:
        """The committed revision caches key on; 0 when unreadable."""
        try:
            return self.lib.revision()
        except StoreWriteError:
            return 0

    def ids(self) -> list[str]:
        """Every record id, in creation order."""
        if not self.lib.exists():
            return []
        with self.lib.read() as con:
            return queries.ids(con)

    def record(self, pid: str) -> dict[str, Any] | None:
        """One record's current-body projection, or ``None``."""
        if not self.lib.exists():
            return None
        with self.lib.read() as con:
            return corpus.record(con, pid)

    def candidates(
        self, text: str, threshold: float, exclude: tuple[str, ...] = ()
    ) -> list[dict[str, Any]]:
        """Records that may be within ``threshold`` of ``text``."""
        if not self.lib.exists():
            return []
        with self.lib.read() as con:
            return queries.candidate_records(con, text, threshold, tuple(exclude))

    def browse(self) -> list[dict[str, Any]]:
        """Preview-sized records, for the exhaustive in-memory scan."""
        if not self.lib.exists():
            return []
        with self.lib.read() as con:
            return corpus.browse(con)
