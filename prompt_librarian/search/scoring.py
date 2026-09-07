"""Token matching tiers and document relevance scoring."""

from __future__ import annotations

import math
from collections.abc import Callable

from .index import Doc, SearchIndex
from .query import ParsedQuery
from .text import _within_edit_1


def tok(
    qt: str,
    fset: frozenset,
    *,
    tier_exact: float,
    tier_prefix: float,
    tier_infix: float,
    tier_edit1: float,
    edit1_min_len: int,
) -> float:
    """Try the O(1) exact match before linear fuzzy scans."""
    if not fset:
        return 0.0
    if qt in fset:
        return tier_exact
    for ft in fset:
        if ft.startswith(qt):
            return tier_prefix
    for ft in fset:
        if qt in ft:
            return tier_infix
    if len(qt) >= edit1_min_len:
        for ft in fset:
            if _within_edit_1(qt, ft):
                return tier_edit1
    return 0.0


def score_doc(
    doc: Doc,
    pq: ParsedQuery,
    index: SearchIndex,
    *,
    token_score: Callable[[str, frozenset], float],
    w_head: float,
    w_tag: float,
    w_body: float,
    phrase_head: float,
    phrase_body: float,
    pop_bonus: float,
    rec_bonus: float,
) -> tuple[float, int]:
    """Return (score, matched_bitmask); the mask supports mode="all" without
    rescanning fields.
    """
    tokens = pq.tokens
    n = len(tokens)
    if not n:
        return 0.0, 0

    s_head = s_tag = s_body = 0.0
    mask = 0
    for i, qt in enumerate(tokens):
        th = token_score(qt, doc.head_set)
        tt = token_score(qt, doc.tags_set)
        tb = token_score(qt, doc.body_set)
        if th or tt or tb:
            mask |= 1 << i
        s_head += th
        s_tag += tt
        s_body += tb

    score = w_head * (s_head / n) + w_tag * (s_tag / n) + w_body * (s_body / n)

    qnorm = pq.qnorm
    if qnorm:
        if qnorm in doc.head_norm:
            score += phrase_head
        if qnorm in doc.body_norm:
            score += phrase_body

    max_used = index.max_used
    if max_used > 0 and doc.used > 0:
        score += pop_bonus * (math.log1p(doc.used) / math.log1p(max_used))
    score += rec_bonus * index.recency01(doc.updated)
    return score, mask
