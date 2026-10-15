"""Search a library (through :class:`LibrarySearchSource`) or plain record lists."""

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
from .labelling import labelled, labeller
from .query import ParsedQuery, parse_query
from .source import LibrarySearchSource
from .upkeep import on_change
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
    source: object,
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
    """Run a search over ``source``; returns one page of scored hits or dupe clusters."""
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
    "labelled",
    "labeller",
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
    "LibrarySearchSource",
    "on_change",
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
