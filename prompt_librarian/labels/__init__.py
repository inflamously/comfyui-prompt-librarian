"""Derived display labels for prompt records.

A record has no stored name: its label is a short handle derived from its body
and the surrounding corpus.  The package facade keeps that small public API in
one place while the implementation is split into configuration, corpus
statistics, text handling, and label generation.

Labels are display strings only.  Identity continues to use record ids and
record discovery continues to use :mod:`prompt_librarian.search`.
"""

from __future__ import annotations

from typing import Any

from .config import (
    ELLIPSIS,
    HEAD_CHARS,
    LABEL_CHARS,
    LABEL_SCAN_CHARS,
    LABEL_SEP,
    LABEL_TERMS,
    MIN_TERM_CHARS,
    STOPWORDS,
)
from .corpus import DocFreq, _document_frequency
from .generation import _label_for
from .text import head_label as _head_label
from .text import term_tokens


def document_frequency(records: Any) -> tuple[dict[str, int], int]:
    """Return ``({term: documents containing it}, document count)``."""
    return _document_frequency(records, scan_chars=LABEL_SCAN_CHARS)


def head_label(body: Any, chars: int = HEAD_CHARS) -> str:
    """Return the body's collapsed, word-boundary-truncated opening words."""
    return _head_label(body, chars, ellipsis=ELLIPSIS)


def label_for(
    body: Any,
    df: DocFreq | None = None,
    ndocs: int = 0,
    chars: int = LABEL_CHARS,
) -> str:
    """Return a short display handle for ``body``.

    ``df`` answers how many records contain a term and ``ndocs`` is the corpus
    size.  With no corpus, the body's opening words are used instead.
    """
    return _label_for(
        body,
        df,
        ndocs,
        chars,
        ellipsis=ELLIPSIS,
        label_terms=LABEL_TERMS,
        label_sep=LABEL_SEP,
        min_term_chars=MIN_TERM_CHARS,
        scan_chars=LABEL_SCAN_CHARS,
        stopwords=STOPWORDS,
    )


def label_for_records(records: Any) -> dict[str, str]:
    """Return ``{id: label}`` for a standalone iterable of records."""
    items = [record for record in (records or ()) if isinstance(record, dict)]
    df, ndocs = document_frequency(items)
    return {
        str(record.get("id") or ""): label_for(record.get("body") or "", df.get, ndocs)
        for record in items
    }


__all__ = [
    "ELLIPSIS",
    "HEAD_CHARS",
    "LABEL_CHARS",
    "LABEL_SCAN_CHARS",
    "LABEL_SEP",
    "LABEL_TERMS",
    "MIN_TERM_CHARS",
    "STOPWORDS",
    "DocFreq",
    "document_frequency",
    "head_label",
    "label_for",
    "label_for_records",
    "term_tokens",
]
