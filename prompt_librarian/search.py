"""Search for the Prompt Librarian.

Pure, stdlib-only. Knows nothing about aiohttp, ComfyUI or the store's file
format: everything is driven either by a plain iterable of record dicts or by
any object exposing the two store methods this module uses (``list_all()`` and
``rev()``).

Record schema consumed here::

    {id, body, tags[], rating, used, last_run,
     created, updated, notes, pinned, versions[]}

There is no ``name``: a record is its body, the handle a row prints is derived
by :mod:`.labels`, and *this* module is what finds a prompt again. That makes
the weights below the whole of how a library is navigated, so they are worth
reading before they are changed.

Timestamps are ISO-8601 with a ``Z`` suffix and therefore sort correctly as
plain strings -- nothing in this module parses a date.

Public API
----------
``normalize(text)``, ``tokenize(text)``, ``preview(body, limit=160)``
``Doc``, ``SearchIndex``, ``ParsedQuery``, ``parse_query(q)``
``build_index(records, rev=0)``, ``get_index(store)``, ``invalidate_index()``
``search(source, query="", **kw) -> dict``
"""

from __future__ import annotations

import bisect
import math
import re
import threading
import time
import unicodedata
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from . import labels

# --------------------------------------------------------------------------
# Tuning constants (module level on purpose -- the scoring formula is a
# product decision, so it must be inspectable and patchable from tests).
# --------------------------------------------------------------------------

# The name field used to carry a weight of its own (3.0, plus an exact-match
# bonus), and it was the field a user searched when they knew what they were
# looking for.  With it gone, the *head* of the body inherits that role: a
# prompt says what it is about in its first line and qualifies it afterwards,
# so an early match is a stronger signal than a late one.  It is a bonus on
# top of W_BODY, not a replacement for it -- a head token scores both.
W_HEAD = 1.5
W_TAG = 2.0
W_BODY = 1.0

HEAD_TOKENS = 12

PHRASE_HEAD = 1.0
PHRASE_BODY = 1.0
POP_BONUS = 0.15
REC_BONUS = 0.10

TIER_EXACT = 1.0
TIER_PREFIX = 0.85
TIER_INFIX = 0.60
TIER_EDIT1 = 0.50

EDIT1_MIN_LEN = 4
PREFIX_EXPAND_CAP = 200
FALLBACK_TERM_CAP = 200
PREVIEW_CHARS = 160
SORT_KEY_CHARS = 120     # of the body, per doc, kept only to sort "az" by

SORTS = ("relevance", "recent", "most_used", "az")
MODES = ("all", "any")

_NON_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
_NEWLINE_RE = re.compile(r"[\r\n]+")
_WS_RE = re.compile(r"\s+", re.UNICODE)


# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------


def normalize(text: Any) -> str:
    """NFKC -> casefold -> strip non-word chars -> collapse whitespace.

    ``casefold()`` rather than ``lower()``: it is the only correct fold for
    German ``ß`` (-> ``ss``) and Turkish dotted capital ``İ``.  ``\\w`` under
    ``re.UNICODE`` keeps CJK and accented letters, so non-Latin prompts
    tokenize instead of vanishing.
    """
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text)
    s = s.casefold()
    s = _NON_WORD_RE.sub(" ", s)
    return " ".join(s.split())


def tokenize(text: Any) -> list[str]:
    """Normalized whitespace-separated tokens."""
    n = normalize(text)
    return n.split() if n else []


def preview(body: Any, limit: int = PREVIEW_CHARS) -> str:
    """Original body (case and punctuation intact) with newlines collapsed."""
    if not body:
        return ""
    if not isinstance(body, str):
        body = str(body)
    s = _NEWLINE_RE.sub(" ", body).strip()
    if len(s) > limit:
        return s[:limit] + "…"
    return s


def _within_edit_1(a: str, b: str) -> bool:
    """True when ``a`` and ``b`` are within Levenshtein distance 1."""
    la, lb = len(a), len(b)
    if la > lb:
        a, b = b, a
        la, lb = lb, la
    if lb - la > 1:  # early exit -- the whole point of doing this by hand
        return False
    if a == b:
        return True
    if la == lb:
        diff = 0
        for x, y in zip(a, b, strict=False):
            if x != y:
                diff += 1
                if diff > 1:
                    return False
        return diff == 1
    # lb == la + 1: a single deletion from b must yield a
    i = j = 0
    skipped = False
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
        elif skipped:
            return False
        else:
            skipped = True
            j += 1
    return True


# --------------------------------------------------------------------------
# Documents and index
# --------------------------------------------------------------------------


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
        body_len=len(body) if isinstance(body, str) else len(str(body)),
    )


class SearchIndex:
    """Inverted index over records.

    ``docs`` maps pid -> :class:`Doc`, ``postings`` maps token -> set of pids,
    ``vocab`` is the sorted token list used for ``bisect`` prefix expansion.
    Single-record writes patch the index (``add``/``remove``/``replace``)
    instead of rebuilding it.

    It also answers the corpus half of :mod:`.labels`: ``postings[token]`` is
    already the set of records containing a token, so ``len()`` of it is that
    token's document frequency and nothing extra has to be counted.
    """

    __slots__ = ("docs", "records", "postings", "vocab", "rev", "_stats_dirty",
                 "_max_used", "_updated_sorted", "_labels")

    def __init__(self, records: Iterable[dict[str, Any]] | None = None, rev: int = 0):
        self.docs: dict[str, Doc] = {}
        self.records: dict[str, dict[str, Any]] = {}
        self.postings: dict[str, set[str]] = {}
        self.vocab: list[str] = []
        self.rev = rev
        self._stats_dirty = True
        self._max_used = 0
        self._updated_sorted: list[str] = []
        self._labels: dict[str, str] = {}
        if records is not None:
            self.build(records, rev=rev)

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
        bucket = self.postings.get(token)
        return len(bucket) if bucket else 0

    def label_for(self, body: Any) -> str:
        """Label any text against this corpus (a version body, a draft)."""
        return labels.label_for(body, self.df, len(self.docs))

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


# -- module-level index cache for a live store ------------------------------

_index_lock = threading.RLock()
_index_cache: dict[int, SearchIndex] = {}
_index_owner: int | None = None


def get_index(store: Any) -> SearchIndex:
    """Return a :class:`SearchIndex` for ``store``, rebuilt only on rev bump.

    ``store`` needs exactly two methods: ``rev()`` and ``list_all()``.
    """
    global _index_owner
    rev = int(store.rev())
    key = id(store)
    with _index_lock:
        if _index_owner != key:
            _index_cache.clear()
            _index_owner = key
        idx = _index_cache.get(rev)
        if idx is None:
            idx = SearchIndex(store.list_all(), rev=rev)
            _index_cache.clear()
            _index_cache[rev] = idx
        return idx


def invalidate_index(rev: int | None = None) -> None:
    """Drop the cached store index (all of it, or one rev)."""
    with _index_lock:
        if rev is None:
            _index_cache.clear()
        else:
            _index_cache.pop(int(rev), None)


# --------------------------------------------------------------------------
# Query parsing
# --------------------------------------------------------------------------


@dataclass(slots=True)
class ParsedQuery:
    raw: str = ""
    text: str = ""                                   # residual free text
    qnorm: str = ""                                  # normalized residual
    tokens: tuple[str, ...] = ()
    phrases: tuple[str, ...] = ()                    # normalized, substring-required
    excludes: tuple[str, ...] = ()                   # normalized tokens
    tags: tuple[str, ...] = ()                       # from tag:x

    def is_empty(self) -> bool:
        return not (self.tokens or self.phrases or self.excludes or self.tags)


_FIELD_OP_RE = re.compile(
    r'(?P<neg>-)?(?P<fieldk>tags?)\s*:\s*'
    r'(?:"(?P<quoted>[^"]*)"|(?P<bare>\S+))',
    re.IGNORECASE,
)
_PHRASE_RE = re.compile(r'"([^"]*)"')


def parse_query(q: Any) -> ParsedQuery:
    """Strip ``tag:``/``-word``/``"phrase"`` before tokenization."""
    raw = q if isinstance(q, str) else ("" if q is None else str(q))
    tags: list[str] = []
    excludes: list[str] = []
    phrases: list[str] = []

    def _take_field(m: re.Match) -> str:
        val = m.group("quoted")
        if val is None:
            val = m.group("bare") or ""
        norm = normalize(val)
        if norm:
            if m.group("neg"):
                # -tag:x behaves as a plain exclusion of that word
                excludes.extend(norm.split())
            else:
                tags.append(norm)
        return " "

    rest = _FIELD_OP_RE.sub(_take_field, raw)

    def _take_phrase(m: re.Match) -> str:
        norm = normalize(m.group(1))
        if norm:
            phrases.append(norm)
            return " " + norm + " "
        return " "

    rest = _PHRASE_RE.sub(_take_phrase, rest)

    keep: list[str] = []
    for word in rest.split():
        if word.startswith("-") and len(word) > 1:
            excludes.extend(tokenize(word[1:]))
        else:
            keep.append(word)

    text = " ".join(keep)
    qnorm = normalize(text)
    tokens = qnorm.split() if qnorm else []
    return ParsedQuery(
        raw=raw,
        text=text,
        qnorm=qnorm,
        tokens=tuple(tokens),
        phrases=tuple(phrases),
        excludes=tuple(dict.fromkeys(excludes)),
        tags=tuple(dict.fromkeys(tags)),
    )


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------


def tok(qt: str, fset: frozenset) -> float:
    """Tier score of one query token against one field's token set.

    Evaluated in tier order and short-circuiting: the ``qt in fset``
    frozenset test is O(1) and is the overwhelmingly common case, so the
    linear scans below it almost never run.
    """
    if not fset:
        return 0.0
    if qt in fset:
        return TIER_EXACT
    for ft in fset:
        if ft.startswith(qt):
            return TIER_PREFIX
    for ft in fset:
        if qt in ft:
            return TIER_INFIX
    if len(qt) >= EDIT1_MIN_LEN:
        for ft in fset:
            if _within_edit_1(qt, ft):
                return TIER_EDIT1
    return 0.0


def score_doc(doc: Doc, pq: ParsedQuery, index: SearchIndex) -> tuple[float, int]:
    """Return ``(score, matched_bitmask)`` for one doc.

    The bitmask records which query tokens scored > 0 in at least one field,
    so the AND gate for ``mode="all"`` costs one integer compare instead of a
    second pass over the fields.
    """
    tokens = pq.tokens
    n = len(tokens)
    if not n:
        return 0.0, 0

    s_head = s_tag = s_body = 0.0
    mask = 0
    for i, qt in enumerate(tokens):
        th = tok(qt, doc.head_set)
        tt = tok(qt, doc.tags_set)
        tb = tok(qt, doc.body_set)
        if th or tt or tb:
            mask |= 1 << i
        s_head += th
        s_tag += tt
        s_body += tb

    score = W_HEAD * (s_head / n) + W_TAG * (s_tag / n) + W_BODY * (s_body / n)

    qnorm = pq.qnorm
    if qnorm:
        if qnorm in doc.head_norm:            # phrase bonus: str.__contains__
            score += PHRASE_HEAD
        if qnorm in doc.body_norm:
            score += PHRASE_BODY

    max_used = index.max_used
    if max_used > 0 and doc.used > 0:
        score += POP_BONUS * (math.log1p(doc.used) / math.log1p(max_used))
    score += REC_BONUS * index.recency01(doc.updated)
    return score, mask


# --------------------------------------------------------------------------
# Filters
# --------------------------------------------------------------------------


def _doc_has_phrase(doc: Doc, phrase: str) -> bool:
    return phrase in doc.body_norm or phrase in doc.tags_norm


def _doc_has_token(doc: Doc, token: str) -> bool:
    return token in doc.body_set or token in doc.tags_set


def _passes_filters(  # noqa: C901 - a flat chain of independent filters
    doc: Doc,
    pq: ParsedQuery,
    tag_norms: Sequence[str],
    dupes_only: bool,
    dupe_ids: set[str] | None,
) -> bool:
    if tag_norms:
        # AND semantics: set(tags) <= set(rec.tags)
        dtags = set(doc.tags_toks)
        for t in tag_norms:
            parts = t.split()
            if len(parts) == 1:
                if parts[0] not in dtags:
                    return False
            elif not set(parts) <= dtags:
                return False
    if pq.tags:
        dtags = set(doc.tags_toks)
        for t in pq.tags:
            parts = t.split()
            if not set(parts) <= dtags:
                return False
    for ph in pq.phrases:
        if not _doc_has_phrase(doc, ph):
            return False
    for ex in pq.excludes:
        if _doc_has_token(doc, ex):
            return False
    return not (dupes_only and dupe_ids is not None and doc.pid not in dupe_ids)


# --------------------------------------------------------------------------
# Sorting
# --------------------------------------------------------------------------


def _sort_scored(scored: list[tuple[Doc, float]], sort: str) -> list[tuple[Doc, float]]:
    """Stable multi-pass sort -- the last pass is the primary key.

    Multi-pass keeps descending-string keys (ISO timestamps) and ascending
    string keys (the body) in one comparator-free scheme.

    ``az`` and every tie-break sort on the body's opening words. They used to
    sort on the name; the body is what the name was a copy of, and unlike the
    derived label it does not move when an unrelated record is saved.
    """
    if sort == "az":
        scored.sort(key=lambda p: p[0].used, reverse=True)
        scored.sort(key=lambda p: p[0].body_disp_lower)
    elif sort == "recent":
        scored.sort(key=lambda p: p[0].body_disp_lower)
        scored.sort(key=lambda p: p[0].updated, reverse=True)
    elif sort == "most_used":
        scored.sort(key=lambda p: p[0].body_disp_lower)
        scored.sort(key=lambda p: p[0].last_run, reverse=True)
        scored.sort(key=lambda p: p[0].used, reverse=True)
    else:  # relevance
        scored.sort(key=lambda p: p[0].body_disp_lower)
        scored.sort(key=lambda p: (-p[1], -p[0].used))
    return scored


# --------------------------------------------------------------------------
# Source coercion
# --------------------------------------------------------------------------


def _as_index(source: Any, rev: int | None = None) -> SearchIndex:
    if isinstance(source, SearchIndex):
        return source
    if source is None:
        return SearchIndex([], rev=rev or 0)
    list_all = getattr(source, "list_all", None)
    rev_fn = getattr(source, "rev", None)
    if callable(list_all) and callable(rev_fn):
        return get_index(source)
    return SearchIndex(list(source), rev=rev or 0)


# --------------------------------------------------------------------------
# search()
# --------------------------------------------------------------------------


def search(  # noqa: C901 - the query pipeline reads better as one function
    source: Any,
    query: str = "",
    *,
    tags: Iterable[str] = (),
    dupes_only: bool = False,
    sort: str = "relevance",
    mode: str = "all",
    offset: int = 0,
    limit: int = 50,
    threshold: float = 0.90,
    rev: int | None = None,
    dupe_ids: Iterable[str] | None = None,
    dupe_count_fn: Callable[[list[str]], dict[str, int]] | None = None,
    match_fn: Callable[[list[str]], dict[str, float]] | None = None,
) -> dict[str, Any]:
    """Run a search.

    ``source`` may be a :class:`SearchIndex`, an iterable of record dicts, or
    any store exposing ``list_all()`` and ``rev()``.

    ``dupe_count_fn`` / ``match_fn`` are injected so this module never has to
    import ``dedupe``.  Both are called **once**, with the list of
    pids on the current page only, and return ``{pid: value}``:
    ``dupe_count_fn`` -> int counts, ``match_fn`` -> similarity in [0, 1]
    against whatever the caller selected (rendered as ``match_pct``).

    ``dupe_ids`` is the precomputed set of ids that have at least one
    near-duplicate; it is required for ``dupes_only`` to have any effect.  If
    ``dupes_only`` is requested without it the filter is skipped and
    ``dupes_partial`` comes back True.

    Returns::

        {rev, total, offset, limit, threshold, took_ms, dupes_partial, hits[]}
    """
    t0 = time.perf_counter()
    index = _as_index(source, rev)
    pq = parse_query(query)

    if sort not in SORTS:
        sort = "relevance"
    if mode not in MODES:
        mode = "all"
    empty_query = not pq.tokens
    if empty_query and sort == "relevance":
        sort = "recent"          # relevance is meaningless without terms

    if isinstance(tags, str):
        tags = [tags]
    tag_norms = [t for t in (normalize(x) for x in (tags or ())) if t]

    dupe_id_set: set[str] | None = None
    if dupe_ids is not None:
        dupe_id_set = set(dupe_ids)
    dupes_partial = bool(dupes_only and dupe_id_set is None)

    docs = index.docs

    # -- candidate generation --------------------------------------------
    fallback_used = False
    if empty_query:
        candidates: Iterable[str] = docs.keys()
    else:
        per_token = [index.candidates_for(qt) for qt in pq.tokens]
        if mode == "all":
            cand: set[str] = set(per_token[0])
            for s in per_token[1:]:
                cand &= s
                if not cand:
                    break
        else:
            cand = set()
            for s in per_token:
                cand |= s
        if not cand:
            # zero-result fallback ONLY: infix + edit-1 vocabulary scan
            fallback_used = True
            cand = set()
            for qt in pq.tokens:
                for term in index.fallback_terms(qt):
                    cand |= index.postings.get(term, ())
        candidates = cand

    full_mask = (1 << len(pq.tokens)) - 1

    scored: list[tuple[Doc, float]] = []
    for pid in candidates:
        doc = docs.get(pid)
        if doc is None:
            continue
        if not _passes_filters(doc, pq, tag_norms, dupes_only, dupe_id_set):
            continue
        if empty_query:
            scored.append((doc, 0.0))
            continue
        sc, mask = score_doc(doc, pq, index)
        if mode == "all" and mask != full_mask:
            continue          # AND gate: every query token must have matched
        if sc <= 0.0:
            continue
        scored.append((doc, sc))

    _sort_scored(scored, sort)

    total = len(scored)
    offset = max(0, int(offset or 0))
    limit = max(0, int(limit if limit is not None else 50))
    page = scored[offset:offset + limit] if limit else []

    pids = [d.pid for d, _ in page]
    counts: dict[str, int] = {}
    matches: dict[str, float] = {}
    if pids:
        if dupe_count_fn is not None:
            try:
                counts = dupe_count_fn(pids) or {}
            except Exception:
                counts = {}
                dupes_partial = True
        else:
            dupes_partial = True
        if match_fn is not None:
            try:
                matches = match_fn(pids) or {}
            except Exception:
                matches = {}

    hits: list[dict[str, Any]] = []
    for doc, sc in page:
        rec = index.records.get(doc.pid, {})
        m = matches.get(doc.pid)
        hits.append({
            "id": doc.pid,
            "label": index.label_of(doc.pid),
            "preview": preview(rec.get("body") or ""),
            "tags": list(rec.get("tags") or ()),
            "rating": doc.rating,
            "used": doc.used,
            "last_run": doc.last_run,
            "updated": doc.updated,
            "chars": doc.body_len,
            "version_count": len(rec.get("versions") or ()),
            "score": round(sc, 6),
            "dupe_count": int(counts.get(doc.pid, 0) or 0),
            "match_pct": (int(round(m * 100)) if isinstance(m, (int, float)) else None),
        })

    return {
        "rev": index.rev if rev is None else rev,
        "total": total,
        "offset": offset,
        "limit": limit,
        "threshold": threshold,
        "took_ms": round((time.perf_counter() - t0) * 1000.0, 3),
        "dupes_partial": dupes_partial,
        "hits": hits,
        "fallback": fallback_used,
    }
