"""Text forms shared by search, duplicate detection and the stored projections."""

import re
import unicodedata

PREVIEW_CHARS = 160

_NON_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
_NEWLINE_RE = re.compile(r"[\r\n]+")
_WS_RE = re.compile(r"\s+", re.UNICODE)


def normalize(text: object) -> str:
    """Comparison form: NFKC, Unicode casefold (ß → ss), word characters only.

    Non-Latin word characters survive; everything else collapses to single spaces.
    """
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return ""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(_NON_WORD_RE.sub(" ", folded).split())


def tokenize(text: object) -> list[str]:
    """Normalized whitespace-separated tokens."""
    normalized = normalize(text)
    return normalized.split() if normalized else []


def preview_of(text: object, chars: int = PREVIEW_CHARS) -> str:
    """Stored one-line excerpt for list rows: every whitespace run collapsed, hard cut."""
    return _WS_RE.sub(" ", str(text or "")).strip()[:chars]


def excerpt(body: object, limit: int = PREVIEW_CHARS) -> str:
    """Display excerpt: newlines collapsed, case kept, an ellipsis when cut."""
    if not body:
        return ""
    if not isinstance(body, str):
        body = str(body)
    flat = _NEWLINE_RE.sub(" ", body).strip()
    return flat[:limit] + "…" if len(flat) > limit else flat


def within_edit_1(a: str, b: str) -> bool:
    """True when ``a`` and ``b`` are within Levenshtein distance 1."""
    if len(a) > len(b):
        a, b = b, a
    if len(b) - len(a) > 1:
        return False
    if a == b:
        return True
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b, strict=False)) == 1
    return _one_insertion(a, b)


def _one_insertion(short: str, long: str) -> bool:
    """True when deleting exactly one character of ``long`` yields ``short``."""
    i = j = 0
    skipped = False
    while i < len(short) and j < len(long):
        if short[i] == long[j]:
            i += 1
        elif skipped:
            return False
        else:
            skipped = True
        j += 1
    return True
