"""Text normalization and fallback rendering for derived labels."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from .config import ELLIPSIS, HEAD_CHARS

WORD_RE = re.compile(r"\w+", re.UNICODE)
WS_RE = re.compile(r"\s+", re.UNICODE)
DIGIT_RE = re.compile(r"\d", re.UNICODE)
NON_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)

# Whitespace can join two selected terms into a phrase.  Punctuation and
# newlines terminate it.
GLUE_RE = re.compile(r"[ \t]*\Z")

Occurrence = tuple[int, int, str, tuple[str, ...]]


def as_text(value: Any) -> str:
    """Coerce a value using the same forgiving rules as the search module."""
    if isinstance(value, str):
        return value
    return "" if value is None else str(value)


def term_tokens(word: str) -> tuple[str, ...]:
    """Fold one surface word into the tokens used by the search index."""
    folded = unicodedata.normalize("NFKC", word).casefold()
    return tuple(NON_WORD_RE.sub(" ", folded).split())


def term_key(pieces: tuple[str, ...]) -> str:
    """Return the stable lookup key for a normalized surface word."""
    return " ".join(pieces)


def is_candidate(key: str, *, min_chars: int, stopwords: frozenset[str]) -> bool:
    """Return whether a term may appear in a label."""
    if not key or key in stopwords:
        return False
    bare = key.replace(" ", "")
    return not (len(bare) < min_chars and not DIGIT_RE.search(bare))


def head_label(body: Any, chars: int = HEAD_CHARS, *, ellipsis: str = ELLIPSIS) -> str:
    """Collapse and truncate the body's opening words on a word boundary."""
    flat = WS_RE.sub(" ", as_text(body)).strip()
    if len(flat) <= chars:
        return flat
    cut = flat[:chars]
    space = cut.rfind(" ")
    if space >= chars // 2:
        cut = cut[:space]
    return cut.rstrip(" ,;:.-") + ellipsis


def occurrences(scan: str) -> list[Occurrence]:
    """Return every word as ``(start, end, key, index tokens)``."""
    found = []
    for match in WORD_RE.finditer(scan):
        pieces = term_tokens(match.group())
        found.append((match.start(), match.end(), term_key(pieces), pieces))
    return found
