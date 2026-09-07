"""The search use case: select candidates and return a ranked result page."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable
from typing import Any

from .cache import _as_index
from .index import Doc, SearchIndex
from .query import ParsedQuery, parse_query
from .results import _fold_groups, _passes_filters, _sort_scored
from .text import normalize, preview


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
    groups: Iterable[Iterable[str]] | None = None,
    score_fn: Callable[[Doc, ParsedQuery, SearchIndex], tuple[float, int]],
    group_member_cap: int,
    sorts: tuple[str, ...],
    modes: tuple[str, ...],
) -> dict[str, Any]:
    """Execute candidate selection, ranking, grouping, and page assembly."""
    t0 = time.perf_counter()
    pq = parse_query(query)

    if sort not in sorts:
        sort = "relevance"
    if mode not in modes:
        mode = "all"
    candidate_fn = getattr(source, "search_candidate_records", None)
    if pq.tokens and callable(candidate_fn):
        stats_fn = getattr(source, "search_corpus_stats", None)
        df_fn = getattr(source, "search_term_df", None)
        corpus = stats_fn() if callable(stats_fn) else None
        index = SearchIndex(
            candidate_fn(pq.tokens, mode),
            rev=rev or int(source.rev()),
            corpus=corpus,
            df_fn=df_fn if callable(df_fn) else None,
        )
    else:
        index = _as_index(source, rev)
    empty_query = not pq.tokens
    if empty_query and sort == "relevance":
        sort = "recent"  # relevance is meaningless without terms

    if isinstance(tags, str):
        tags = [tags]
    tag_norms = [t for t in (normalize(x) for x in (tags or ())) if t]

    dupe_id_set: set[str] | None = None
    if dupe_ids is not None:
        dupe_id_set = set(dupe_ids)
    dupes_partial = bool(dupes_only and dupe_id_set is None)

    docs = index.docs

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
        sc, mask = score_fn(doc, pq, index)
        if mode == "all" and mask != full_mask:
            continue
        if sc <= 0.0:
            continue
        scored.append((doc, sc))

    _sort_scored(scored, sort)

    # Fold the full sorted list before paging, since cluster members can be scattered.
    record_total = len(scored)
    members_of: dict[str, list[tuple[Doc, float]]] = {}
    if groups:
        scored, members_of = _fold_groups(scored, groups)

    total = len(scored)
    offset = max(0, int(offset or 0))
    limit = max(0, int(limit if limit is not None else 50))
    page = scored[offset : offset + limit] if limit else []

    # Cap members per cluster to bound response size; group_size reports the full count.
    shown_members = {
        doc.pid: (members_of.get(doc.pid) or ())[:group_member_cap]
        for doc, _ in page
        if members_of.get(doc.pid)
    }

    pids = [d.pid for d, _ in page]
    for shown in shown_members.values():
        pids.extend(d.pid for d, _ in shown)
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

    def _hit(doc, sc, group_size):
        rec = index.records.get(doc.pid, {})
        m = matches.get(doc.pid)
        return {
            "id": doc.pid,
            "label": index.label_of(doc.pid),
            "preview": preview(rec.get("body") or ""),
            "tags": list(rec.get("tags") or ()),
            "rating": doc.rating,
            "used": doc.used,
            "last_run": doc.last_run,
            "updated": doc.updated,
            "chars": doc.body_len,
            "version_count": int(rec.get("_version_count", len(rec.get("versions") or ())) or 0),
            "score": round(sc, 6),
            "dupe_count": int(counts.get(doc.pid, 0) or 0),
            "match_pct": (int(round(m * 100)) if isinstance(m, (int, float)) else None),
            "group_size": int(group_size),
        }

    hits: list[dict[str, Any]] = []
    group_rows: dict[str, list[dict[str, Any]]] = {}
    for doc, sc in page:
        shown = shown_members.get(doc.pid) or ()
        hits.append(_hit(doc, sc, 1 + len(members_of.get(doc.pid) or ())))
        if shown:
            group_rows[doc.pid] = [_hit(d, s, 1) for d, s in shown]

    return {
        "rev": index.rev if rev is None else rev,
        "total": total,
        "record_total": record_total,
        "offset": offset,
        "limit": limit,
        "threshold": threshold,
        "took_ms": round((time.perf_counter() - t0) * 1000.0, 3),
        "dupes_partial": dupes_partial,
        "hits": hits,
        "groups": group_rows,
        "fallback": fallback_used,
    }
