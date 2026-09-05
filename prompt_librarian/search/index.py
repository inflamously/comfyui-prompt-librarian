"""Documents, incremental inverted indexing, and corpus statistics."""

from __future__ import annotations

import bisect
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from .. import labels
from .config import EDIT1_MIN_LEN, FALLBACK_TERM_CAP, HEAD_TOKENS, PREFIX_EXPAND_CAP, SORT_KEY_CHARS
from .text import _WS_RE, _within_edit_1, normalize


@dataclass(slots=True)
class Doc:
    """One indexed record.  Everything scoring needs, nothing it does not."""

    pid: str
    body_norm: str
    tags_norm: str
    head_norm: str
    body_toks: tuple[str, ...]
    tags_toks: tuple[str, ...]
    head_set: frozenset
    body_set: frozenset
    tags_set: frozenset
    all_toks: frozenset
    used: int
    rating: int
    updated: str
    last_run: str
    created: str
    body_disp_lower: str
    body_len: int


def make_doc(rec: dict[str, Any]) -> Doc:
    """Build a :class:`Doc` from a raw record dict."""
    pid = str(rec.get("id") or "")
    body = rec.get("body") or ""
    tags = rec.get("tags") or ()
    if isinstance(tags, str):
        tags = [tags]

    body_norm = normalize(body)
    tags_norm = " ".join(t for t in (normalize(x) for x in tags) if t)

    body_toks = tuple(body_norm.split())
    tags_toks = tuple(tags_norm.split())
    head_toks = body_toks[:HEAD_TOKENS]

    head_set = frozenset(head_toks)
    body_set = frozenset(body_toks)
    tags_set = frozenset(tags_toks)

    try:
        used = int(rec.get("used") or 0)
    except (TypeError, ValueError):
        used = 0
    try:
        rating = int(rec.get("rating") or 0)
    except (TypeError, ValueError):
        rating = 0
    try:
        body_len = int(rec.get("_chars", len(body) if isinstance(body, str) else len(str(body))))
    except (TypeError, ValueError):
        body_len = len(body) if isinstance(body, str) else len(str(body))

    return Doc(
        pid=pid,
        body_norm=body_norm,
        tags_norm=tags_norm,
        head_norm=" ".join(head_toks),
        body_toks=body_toks,
        tags_toks=tags_toks,
        head_set=head_set,
        body_set=body_set,
        tags_set=tags_set,
        all_toks=body_set | tags_set,
        used=used,
        rating=rating,
        updated=str(rec.get("updated") or ""),
        last_run=str(rec.get("last_run") or ""),
        created=str(rec.get("created") or ""),
        # The "az" sort key. Alphabetical by the prompt's own opening words --
        # not by its label, which is corpus-derived and would therefore reorder
        # the list every time an unrelated record was saved.
        body_disp_lower=_WS_RE.sub(" ", str(body)).strip()[:SORT_KEY_CHARS].casefold(),
        body_len=max(0, body_len),
    )


class SearchIndex:
    """Inverted index over records.

    ``docs`` maps pid -> :class:`Doc`, ``postings`` maps token -> set of pids,
    ``vocab`` is the sorted token list used for ``bisect`` prefix expansion.
    Single-record writes patch the index (``add``/``remove``/``replace``)
    instead of rebuilding it.

    It also answers the corpus half of :mod:`prompt_librarian.labels`: ``postings[token]`` is
    already the set of records containing a token, so ``len()`` of it is that
    token's document frequency and nothing extra has to be counted.
    """

    __slots__ = (
        "docs",
        "records",
        "postings",
        "vocab",
        "rev",
        "_stats_dirty",
        "_max_used",
        "_updated_sorted",
        "_labels",
        "_df_fn",
        "_corpus_count",
    )

    def __init__(
        self,
        records: Iterable[dict[str, Any]] | None = None,
        rev: int = 0,
        *,
        corpus: dict[str, Any] | None = None,
        df_fn: Callable[[str], int] | None = None,
    ):
        self.docs: dict[str, Doc] = {}
        self.records: dict[str, dict[str, Any]] = {}
        self.postings: dict[str, set[str]] = {}
        self.vocab: list[str] = []
        self.rev = rev
        self._stats_dirty = True
        self._max_used = 0
        self._updated_sorted: list[str] = []
        self._labels: dict[str, str] = {}
        self._df_fn = df_fn
        self._corpus_count = 0
        if records is not None:
            self.build(records, rev=rev)
        if corpus:
            self._corpus_count = max(0, int(corpus.get("count") or 0))
            self._max_used = max(0, int(corpus.get("max_used") or 0))
            self._updated_sorted = list(corpus.get("updated") or ())
            self._stats_dirty = False

    # -- construction ------------------------------------------------------

    def build(self, records: Iterable[dict[str, Any]], rev: int | None = None) -> SearchIndex:
        """Full rebuild from ``records``."""
        self.docs = {}
        self.records = {}
        postings: dict[str, set[str]] = {}
        for rec in records or ():
            if not isinstance(rec, dict):
                continue
            doc = make_doc(rec)
            if not doc.pid:
                continue
            self.docs[doc.pid] = doc
            self.records[doc.pid] = rec
            for tok in doc.all_toks:
                bucket = postings.get(tok)
                if bucket is None:
                    postings[tok] = {doc.pid}
                else:
                    bucket.add(doc.pid)
        self.postings = postings
        self.vocab = sorted(postings)
        if rev is not None:
            self.rev = rev
        self._stats_dirty = True
        self._labels = {}
        return self

    def add(self, rec: dict[str, Any]) -> Doc | None:
        """Incrementally index one record (replaces it if already present)."""
        if not isinstance(rec, dict):
            return None
        doc = make_doc(rec)
        if not doc.pid:
            return None
        if doc.pid in self.docs:
            self.remove(doc.pid)
        self.docs[doc.pid] = doc
        self.records[doc.pid] = rec
        postings = self.postings
        vocab = self.vocab
        for tok in doc.all_toks:
            bucket = postings.get(tok)
            if bucket is None:
                postings[tok] = {doc.pid}
                bisect.insort(vocab, tok)
            else:
                bucket.add(doc.pid)
        self._stats_dirty = True
        # Every label is a function of the whole corpus, so one added record
        # can change any of them. Nothing finer than "drop the lot" is correct.
        self._labels = {}
        return doc

    def remove(self, pid: str) -> bool:
        """Drop one record from the index."""
        doc = self.docs.pop(pid, None)
        if doc is None:
            return False
        self.records.pop(pid, None)
        postings = self.postings
        vocab = self.vocab
        for tok in doc.all_toks:
            bucket = postings.get(tok)
            if bucket is None:
                continue
            bucket.discard(pid)
            if not bucket:
                del postings[tok]
                i = bisect.bisect_left(vocab, tok)
                if i < len(vocab) and vocab[i] == tok:
                    del vocab[i]
        self._stats_dirty = True
        self._labels = {}
        return True

    def replace(self, rec: dict[str, Any]) -> Doc | None:
        """Re-index one record in place."""
        return self.add(rec)

    # -- labels ------------------------------------------------------------

    def df(self, token: str) -> int:
        """How many records contain ``token`` -- the corpus half of a label."""
        if self._df_fn is not None:
            try:
                return max(0, int(self._df_fn(token)))
            except Exception:
                pass
        bucket = self.postings.get(token)
        return len(bucket) if bucket else 0

    def label_for(self, body: Any) -> str:
        """Label any text against this corpus (a version body, a draft)."""
        return labels.label_for(body, self.df, self._corpus_count or len(self.docs))

    def label_of(self, pid: str) -> str:
        """Label one indexed record, memoized for the life of the index.

        A search page labels up to 50 records and the panel re-requests the
        same page on every filter toggle, so the cache is what keeps labelling
        off the per-keystroke path. It is dropped wholesale on any write --
        see :meth:`add`.
        """
        hit = self._labels.get(pid)
        if hit is None:
            hit = self.label_for((self.records.get(pid) or {}).get("body") or "")
            self._labels[pid] = hit
        return hit

    # -- stats -------------------------------------------------------------

    def _refresh_stats(self) -> None:
        max_used = 0
        stamps = []
        for doc in self.docs.values():
            if doc.used > max_used:
                max_used = doc.used
            stamps.append(doc.updated)
        stamps.sort()
        self._max_used = max_used
        self._updated_sorted = stamps
        self._stats_dirty = False

    @property
    def max_used(self) -> int:
        if self._stats_dirty:
            self._refresh_stats()
        return self._max_used

    def recency01(self, updated: str) -> float:
        """Rank of ``updated`` among all docs, mapped to [0, 1].

        Rank based rather than clock based: no date parsing, no dependence on
        "now", and stable under test.
        """
        if self._stats_dirty:
            self._refresh_stats()
        stamps = self._updated_sorted
        n = len(stamps)
        if n < 2:
            return 1.0 if n else 0.0
        i = bisect.bisect_left(stamps, updated)
        if i >= n:
            i = n - 1
        return i / (n - 1)

    # -- candidate generation ---------------------------------------------

    def expand_prefix(self, prefix: str, cap: int = PREFIX_EXPAND_CAP) -> list[str]:
        """Vocabulary terms starting with ``prefix`` (``bisect`` walk, capped)."""
        vocab = self.vocab
        out: list[str] = []
        i = bisect.bisect_left(vocab, prefix)
        n = len(vocab)
        while i < n and len(out) < cap:
            term = vocab[i]
            if not term.startswith(prefix):
                break
            out.append(term)
            i += 1
        return out

    def fallback_terms(self, token: str, cap: int = FALLBACK_TERM_CAP) -> list[str]:
        """Zero-result fallback only: linear vocab scan for infix / edit-1.

        Never runs on the happy path -- callers must have produced no hits
        first.  ~3 ms on a 5k-record vocabulary, which is acceptable exactly
        because it is the miss path.
        """
        out: list[str] = []
        allow_edit = len(token) >= EDIT1_MIN_LEN
        for term in self.vocab:
            if token in term or (allow_edit and _within_edit_1(token, term)):
                out.append(term)
                if len(out) >= cap:
                    break
        return out

    def candidates_for(self, token: str) -> set[str]:
        """Exact posting plus prefix expansion for one query token."""
        out: set[str] = set()
        bucket = self.postings.get(token)
        if bucket:
            out |= bucket
        for term in self.expand_prefix(token):
            if term != token:
                out |= self.postings.get(term, ())
        return out

    def __len__(self) -> int:
        return len(self.docs)

    def __contains__(self, pid: object) -> bool:
        return pid in self.docs


def build_index(records: Iterable[dict[str, Any]], rev: int = 0) -> SearchIndex:
    """Convenience constructor."""
    return SearchIndex(records, rev=rev)
