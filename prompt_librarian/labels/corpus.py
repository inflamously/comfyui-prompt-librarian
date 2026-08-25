"""Corpus statistics used to select distinctive label terms."""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

from .text import WORD_RE, as_text, term_tokens

DocFreq = Callable[[str], int]


def _document_frequency(records: Any, *, scan_chars: int) -> tuple[dict[str, int], int]:
    """Count documents containing each normalized term in raw records."""
    frequencies: dict[str, int] = {}
    count = 0
    for record in records or ():
        if not isinstance(record, dict):
            continue
        count += 1
        seen = set()
        tags = record.get("tags") or ()
        if isinstance(tags, str):
            tags = [tags]
        for chunk in (record.get("body") or "", *(as_text(tag) for tag in tags)):
            for match in WORD_RE.finditer(chunk[:scan_chars]):
                seen.update(term_tokens(match.group()))
        for token in seen:
            frequencies[token] = frequencies.get(token, 0) + 1
    return frequencies, count


def idf(df: int, ndocs: int) -> float:
    """Return smoothed inverse document frequency."""
    return math.log((ndocs + 1) / (df + 0.5))
