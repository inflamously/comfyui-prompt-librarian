"""Result filtering, stable sorting, and duplicate-group folding."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from .index import Doc
from .query import ParsedQuery


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


def _sort_scored(scored: list[tuple[Doc, float]], sort: str) -> list[tuple[Doc, float]]:
    """The last stable sort is primary. Use body text for tie-breaks because
    corpus-derived labels can change when unrelated records are saved.
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
    else:
        scored.sort(key=lambda p: p[0].body_disp_lower)
        scored.sort(key=lambda p: (-p[1], -p[0].used))
    return scored


def _fold_groups(
    scored: list[tuple[Doc, float]], groups: Iterable[Iterable[str]]
) -> tuple[list[tuple[Doc, float]], dict[str, list[tuple[Doc, float]]]]:
    """Use the first already-sorted member as the cluster representative.
    A cluster with one surviving query match remains a plain row.
    """
    gid: dict[str, int] = {}
    for i, members in enumerate(groups or ()):
        for pid in members or ():
            gid[str(pid)] = i

    rep_at: dict[int, str] = {}
    members_of: dict[str, list[tuple[Doc, float]]] = {}
    out: list[tuple[Doc, float]] = []
    for entry in scored:
        g = gid.get(entry[0].pid)
        if g is None:
            out.append(entry)
            continue
        rep = rep_at.get(g)
        if rep is None:
            rep_at[g] = entry[0].pid
            members_of[entry[0].pid] = []
            out.append(entry)
        else:
            members_of[rep].append(entry)
    return out, members_of
