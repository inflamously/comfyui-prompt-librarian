"""Accept record iterables or a store exposing list_all() and rev().
ISO-8601 timestamps with a Z suffix sort lexicographically. Scoring weights
remain configurable through this public facade.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from . import scoring as _scoring
from . import service as _service
from .cache import get_index, invalidate_index
from .config import (
    W_HEAD,
    W_TAG,
    W_BODY,
    HEAD_TOKENS,
    PHRASE_HEAD,
    PHRASE_BODY,
    POP_BONUS,
    REC_BONUS,
    TIER_EXACT,
    TIER_PREFIX,
    TIER_INFIX,
    TIER_EDIT1,
    EDIT1_MIN_LEN,
    PREFIX_EXPAND_CAP,
    FALLBACK_TERM_CAP,
    PREVIEW_CHARS,
    SORT_KEY_CHARS,
    SORTS,
    MODES,
    GROUP_MEMBER_CAP,
)
from .index import Doc, SearchIndex, build_index, make_doc
from .query import ParsedQuery, parse_query
from .text import _within_edit_1, normalize, preview, tokenize


def tok(qt: str, fset: frozenset) -> float:
    """Tier score of a query token using the public tuning constants."""
    return _scoring.tok(
        qt,
        fset,
        tier_exact=TIER_EXACT,
        tier_prefix=TIER_PREFIX,
        tier_infix=TIER_INFIX,
        tier_edit1=TIER_EDIT1,
        edit1_min_len=EDIT1_MIN_LEN,
    )


def score_doc(doc: Doc, pq: ParsedQuery, index: SearchIndex) -> tuple[float, int]:
    """Return (relevance score, matched-token bitmask) using public weights."""
    return _scoring.score_doc(
        doc,
        pq,
        index,
        token_score=tok,
        w_head=W_HEAD,
        w_tag=W_TAG,
        w_body=W_BODY,
        phrase_head=PHRASE_HEAD,
        phrase_body=PHRASE_BODY,
        pop_bonus=POP_BONUS,
        rec_bonus=REC_BONUS,
    )


def search(
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
    groups: Iterable[Iterable[str]] | None = None,
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

    ``groups`` -- the connected components of the near-duplicate graph, as
    ``dedupe.dupe_counts()['groups']`` -- turns the result into one row per
    *cluster* instead of one row per record.  Passed as plain id lists so this
    module still never imports :mod:`prompt_librarian.dedupe`.

    Returns::

        {rev, total, record_total, offset, limit, threshold, took_ms,
         dupes_partial, hits[], groups{rep_id: hit[]}}

    ``total`` counts rows the caller will page over -- clusters and singletons
    once folding is on -- and ``record_total`` counts the records behind them.
    Without ``groups`` they are equal and ``groups{}`` is empty.
    """
    return _service.search(
        source,
        query,
        tags=tags,
        dupes_only=dupes_only,
        sort=sort,
        mode=mode,
        offset=offset,
        limit=limit,
        threshold=threshold,
        rev=rev,
        dupe_ids=dupe_ids,
        dupe_count_fn=dupe_count_fn,
        match_fn=match_fn,
        groups=groups,
        score_fn=score_doc,
        group_member_cap=GROUP_MEMBER_CAP,
        sorts=SORTS,
        modes=MODES,
    )


__all__ = [
    "W_HEAD",
    "W_TAG",
    "W_BODY",
    "HEAD_TOKENS",
    "PHRASE_HEAD",
    "PHRASE_BODY",
    "POP_BONUS",
    "REC_BONUS",
    "TIER_EXACT",
    "TIER_PREFIX",
    "TIER_INFIX",
    "TIER_EDIT1",
    "EDIT1_MIN_LEN",
    "PREFIX_EXPAND_CAP",
    "FALLBACK_TERM_CAP",
    "PREVIEW_CHARS",
    "SORT_KEY_CHARS",
    "SORTS",
    "MODES",
    "GROUP_MEMBER_CAP",
    "Doc",
    "SearchIndex",
    "ParsedQuery",
    "build_index",
    "get_index",
    "invalidate_index",
    "make_doc",
    "normalize",
    "parse_query",
    "preview",
    "score_doc",
    "search",
    "tok",
    "tokenize",
]
