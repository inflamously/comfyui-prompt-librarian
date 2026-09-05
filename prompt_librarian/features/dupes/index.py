"""In-memory candidate index for near-duplicate matching."""

from __future__ import annotations

import sys
from collections.abc import Iterable
from typing import Any

from .core import length_ok, sim_norm

RARE_TOKENS = 8
DF_ABS = 50
DF_FRAC = 0.15
OVERLAP_FRAC = 0.5
SHORT_DOC_TOKENS = 4


def _setting(name: str, fallback: int | float) -> int | float:
    """Read exported tuning knobs so callers can override them for tests."""
    package = sys.modules.get(__package__)
    return getattr(package, name, fallback) if package is not None else fallback


class DupeIndex:
    """Inverted index and length buckets for two-stage candidate generation."""

    __slots__ = ("records", "norms", "toks", "postings", "length_buckets", "rev")

    def __init__(
        self,
        records: Iterable[dict[str, Any]] | None = None,
        rev: int | None = None,
    ) -> None:
        """Index ``records`` (if given) as of revision ``rev``."""
        self.records: dict[str, dict[str, Any]] = {}
        self.norms: dict[str, str] = {}
        self.toks: dict[str, frozenset] = {}
        self.postings: dict[str, set[str]] = {}
        self.length_buckets: dict[int, set[str]] = {}
        self.rev = rev
        if records is not None:
            self.build(records, rev=rev)

    def build(
        self,
        records: Iterable[dict[str, Any]],
        rev: int | None = None,
    ) -> DupeIndex:
        """Replace the whole index with ``records`` as of revision ``rev``."""
        self.records = {}
        self.norms = {}
        self.toks = {}
        self.postings = {}
        self.length_buckets = {}
        for rec in records or ():
            if isinstance(rec, dict):
                self.add(rec)
        if rev is not None:
            self.rev = rev
        return self

    def add(self, rec: dict[str, Any]) -> str | None:
        """Index one record (replacing any earlier copy); returns its id, or ``None``."""
        if not isinstance(rec, dict):
            return None
        pid = str(rec.get("id") or "")
        if not pid:
            return None
        if pid in self.records:
            self.remove(pid)
        norm = sim_norm(rec.get("body") or "")
        toks = frozenset(norm.split())
        self.records[pid] = rec
        self.norms[pid] = norm
        self.toks[pid] = toks
        for token in toks:
            self.postings.setdefault(token, set()).add(pid)
        self.length_buckets.setdefault(len(toks), set()).add(pid)
        return pid

    def remove(self, pid: str) -> bool:
        """Drop one record from every posting; ``False`` when it was not indexed."""
        if pid not in self.records:
            return False
        toks = self.toks.pop(pid, frozenset())
        for token in toks:
            bucket = self.postings.get(token)
            if bucket is not None:
                bucket.discard(pid)
                if not bucket:
                    del self.postings[token]
        length_bucket = self.length_buckets.get(len(toks))
        if length_bucket is not None:
            length_bucket.discard(pid)
            if not length_bucket:
                del self.length_buckets[len(toks)]
        self.norms.pop(pid, None)
        self.records.pop(pid, None)
        return True

    def replace(self, rec: dict[str, Any]) -> str | None:
        """Same as :meth:`add`; the name reads better at call sites that update."""
        return self.add(rec)

    def __len__(self) -> int:
        """Number of indexed records."""
        return len(self.records)

    def df(self, token: str) -> int:
        """How many indexed records contain ``token``."""
        bucket = self.postings.get(token)
        return len(bucket) if bucket else 0

    def candidates(
        self,
        toks: frozenset,
        norm_len: int,
        threshold: float,
        exclude: Iterable[str] = (),
    ) -> set[str]:
        """Apply rare-token blocking followed by cheap exact prefilters."""
        candidates = self._blocked(toks) - set(exclude)
        return {pid for pid in candidates if self._plausible(pid, toks, norm_len, threshold)}

    def _blocked(self, toks: frozenset) -> set[str]:
        """Records sharing a rare token, plus similar-size records for short probes."""
        cap = max(_setting("DF_ABS", DF_ABS), _setting("DF_FRAC", DF_FRAC) * len(self.records))
        rare = sorted((token for token in toks if self.df(token) <= cap), key=self.df)
        candidates: set[str] = set()
        for token in rare[: int(_setting("RARE_TOKENS", RARE_TOKENS))]:
            candidates |= self.postings.get(token, set())
        if len(toks) < _setting("SHORT_DOC_TOKENS", SHORT_DOC_TOKENS) or not candidates:
            for bucket in (len(toks) - 1, len(toks), len(toks) + 1):
                candidates |= self.length_buckets.get(bucket, set())
        return candidates

    def _plausible(self, pid: str, toks: frozenset, norm_len: int, threshold: float) -> bool:
        """The length bound on the ratio, then enough tokens in common."""
        if not length_ok(norm_len, len(self.norms.get(pid, "")), threshold):
            return False
        other_toks = self.toks.get(pid) or frozenset()
        if not toks or not other_toks:
            return True
        needed = _setting("OVERLAP_FRAC", OVERLAP_FRAC) * min(len(toks), len(other_toks))
        return len(toks & other_toks) >= needed


def build_dupe_index(
    records: Iterable[dict[str, Any]],
    rev: int | None = None,
) -> DupeIndex:
    """Build a duplicate candidate index from record dictionaries."""
    return DupeIndex(records, rev=rev)
