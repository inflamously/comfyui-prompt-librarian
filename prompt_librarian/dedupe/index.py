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
    ):
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
        return self.add(rec)

    def __len__(self) -> int:
        return len(self.records)

    def df(self, token: str) -> int:
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
        nrecords = len(self.records)
        cap = max(
            _setting("DF_ABS", DF_ABS),
            _setting("DF_FRAC", DF_FRAC) * nrecords,
        )
        rare = sorted(
            (token for token in toks if self.df(token) <= cap),
            key=self.df,
        )[: int(_setting("RARE_TOKENS", RARE_TOKENS))]

        candidates: set[str] = set()
        for token in rare:
            candidates |= self.postings.get(token, set())

        if len(toks) < _setting("SHORT_DOC_TOKENS", SHORT_DOC_TOKENS) or not candidates:
            token_count = len(toks)
            for bucket in (token_count - 1, token_count, token_count + 1):
                candidates |= self.length_buckets.get(bucket, set())

        for pid in exclude:
            candidates.discard(pid)
        if not candidates:
            return candidates

        source_token_count = len(toks)
        result: set[str] = set()
        for pid in candidates:
            other_norm_len = len(self.norms.get(pid, ""))
            if not length_ok(norm_len, other_norm_len, threshold):
                continue
            other_toks = self.toks.get(pid) or frozenset()
            other_token_count = len(other_toks)
            if source_token_count and other_token_count:
                needed = _setting("OVERLAP_FRAC", OVERLAP_FRAC) * min(
                    source_token_count,
                    other_token_count,
                )
                if len(toks & other_toks) < needed:
                    continue
            result.add(pid)
        return result


def build_dupe_index(
    records: Iterable[dict[str, Any]],
    rev: int | None = None,
) -> DupeIndex:
    """Build a duplicate candidate index from record dictionaries."""
    return DupeIndex(records, rev=rev)
