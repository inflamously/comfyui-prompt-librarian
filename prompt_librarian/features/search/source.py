"""Search's view of a library: candidates from SQLite, statistics cached per revision."""

from typing import Any

from ...shared import corpus
from ...shared.errors import StoreWriteError
from ...shared.library import Library
from ...shared.text import normalize
from . import queries


class LibrarySearchSource:
    """What :func:`search` and :func:`get_index` read from a library on disk."""

    def __init__(self, lib: Library) -> None:
        """Wrap ``lib``; nothing is read until asked."""
        self.lib = lib
        self._cache_rev = -1
        self._stats: dict[str, Any] | None = None
        self._df: dict[str, int] = {}

    def revision(self) -> int:
        """The committed revision caches key on; 0 when unreadable."""
        try:
            return self.lib.revision()
        except StoreWriteError:
            return 0

    def browse(self) -> list[dict[str, Any]]:
        """Preview-sized records for browsing without a query."""
        if not self.lib.exists():
            return []
        with self.lib.read() as con:
            return corpus.browse(con)

    def candidates(self, tokens: list[str], mode: str) -> list[dict[str, Any]]:
        """Records that can match ``tokens``; the scorer ranks them."""
        if not self.lib.exists():
            return []
        with self.lib.read() as con:
            return queries.candidate_records(con, tokens, mode, self.lib.fts5)

    def _fresh(self) -> None:
        revision = self.revision()
        if revision != self._cache_rev:
            self._cache_rev, self._stats, self._df = revision, None, {}

    def corpus_stats(self) -> dict[str, Any]:
        """Record count, highest usage and ``updated`` stamps, for popularity/recency."""
        self._fresh()
        if self._stats is None:
            if self.lib.exists():
                with self.lib.read() as con:
                    self._stats = queries.corpus_stats(con)
            else:
                self._stats = {"count": 0, "max_used": 0, "updated": []}
        return self._stats

    def term_df(self, token: str) -> int:
        """Document frequency of ``token``, for rare-term weighting."""
        self._fresh()
        wanted = normalize(token)
        if not wanted or not self.lib.exists():
            return 0
        if wanted not in self._df:
            with self.lib.read() as con:
                self._df[wanted] = queries.term_df(con, wanted)
        return self._df[wanted]
