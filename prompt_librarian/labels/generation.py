"""Distinctive-term selection and final label generation."""

from __future__ import annotations

import math
from typing import Any

from .corpus import DocFreq, idf
from .text import (
    GLUE_RE,
    WS_RE,
    Occurrence,
    as_text,
    head_label,
    is_candidate,
    occurrences,
)


def _df_of(pieces: tuple[str, ...], df: DocFreq) -> int:
    """Return the document frequency of a surface word's rarest piece."""
    best = None
    for piece in pieces:
        try:
            seen = max(int(df(piece)), 0)
        except Exception:
            seen = 0
        if best is None or seen < best:
            best = seen
    return best or 0


def _pick_terms(
    found: list[Occurrence],
    df: DocFreq,
    ndocs: int,
    *,
    limit: int,
    min_chars: int,
    stopwords: frozenset[str],
) -> set[str]:
    """Return the most distinctive terms in one body."""
    term_frequency: dict[str, int] = {}
    first: dict[str, int] = {}
    pieces_of: dict[str, tuple[str, ...]] = {}
    for start, _end, key, pieces in found:
        if not is_candidate(key, min_chars=min_chars, stopwords=stopwords):
            continue
        term_frequency[key] = term_frequency.get(key, 0) + 1
        first.setdefault(key, start)
        pieces_of.setdefault(key, pieces)
    if not term_frequency:
        return set()

    scored = []
    for key, count in term_frequency.items():
        weight = (1.0 + math.log(count)) * idf(_df_of(pieces_of[key], df), ndocs)
        scored.append((-weight, first[key], key))
    scored.sort()
    return {key for _weight, _position, key in scored[:limit]}


def _phrases(scan: str, found: list[Occurrence], chosen: set[str]) -> list[str]:
    """Render selected terms in body order, merging adjacent terms."""
    output: list[str] = []
    seen: set[str] = set()
    run_start = run_end = None
    run_key: list[str] = []

    def flush() -> None:
        nonlocal run_start, run_end, run_key
        if run_start is not None:
            key = " ".join(run_key)
            if key not in seen:
                seen.add(key)
                output.append(WS_RE.sub(" ", scan[run_start:run_end]).strip())
        run_start = run_end = None
        run_key = []

    for start, end, key, _pieces in found:
        if key not in chosen:
            flush()
            continue
        if run_start is not None and GLUE_RE.match(scan, run_end, start):
            run_end = end
            run_key.append(key)
            continue
        flush()
        run_start, run_end, run_key = start, end, [key]
    flush()
    return output


def _render(phrases: list[str], chars: int, *, ellipsis: str, separator: str) -> str:
    """Join phrases while they fit, without returning an empty label."""
    output = ""
    for phrase in phrases:
        candidate = phrase if not output else output + separator + phrase
        if len(candidate) > chars:
            break
        output = candidate
    if output:
        return output
    return head_label(phrases[0], chars, ellipsis=ellipsis) if phrases else ""


def _label_for(
    body: Any,
    df: DocFreq | None,
    ndocs: int,
    chars: int,
    *,
    ellipsis: str,
    label_terms: int,
    label_sep: str,
    min_term_chars: int,
    scan_chars: int,
    stopwords: frozenset[str],
) -> str:
    """Generate a label using settings supplied by the package facade."""
    text = as_text(body)
    if not text.strip():
        return ""
    if df is None or ndocs <= 0:
        return head_label(text, chars, ellipsis=ellipsis)
    scan = text[:scan_chars]
    found = occurrences(scan)
    chosen = _pick_terms(
        found,
        df,
        ndocs,
        limit=label_terms,
        min_chars=min_term_chars,
        stopwords=stopwords,
    )
    if not chosen:
        return head_label(text, chars, ellipsis=ellipsis)
    return _render(
        _phrases(scan, found, chosen), chars, ellipsis=ellipsis, separator=label_sep
    ) or head_label(text, chars, ellipsis=ellipsis)
