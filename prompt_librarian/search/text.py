"""Unicode normalization, preview text, and edit-distance matching."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from .config import PREVIEW_CHARS

_NON_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
_NEWLINE_RE = re.compile(r"[\r\n]+")
_WS_RE = re.compile(r"\s+", re.UNICODE)


def normalize(text: Any) -> str:
    """Use Unicode casefolding (including ß → ss) and preserve non-Latin word characters."""
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
    if lb - la > 1:
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
