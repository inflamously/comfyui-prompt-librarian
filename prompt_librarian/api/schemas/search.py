"""Searching the library and autocompleting while typing."""

from dataclasses import dataclass, field
from typing import Literal

from .base import Envelope, _Schema


@dataclass
class SearchHit(_Schema):
    """One row of a search page."""

    id: str
    label: str
    """The row's handle: this body's most distinctive terms, against the rest
    of the library. Derived per response, never stored, and free to change when
    the library around it does — sort and filter on the other fields."""
    preview: str
    tags: list[str]
    rating: int
    used: int
    last_run: str
    updated: str
    chars: int
    version_count: int
    score: float
    dupe_count: int
    """Near-duplicates of this record, counted for this page only. Counts every
    one of them: a "keep both" mute silences the save dialog, it does not make
    a duplicate stop existing."""
    match_pct: int | None
    """Similarity to ``match_id``; null when below the threshold, or unasked."""
    group_size: int
    """Records in this row's near-duplicate cluster, itself included. Always 1
    unless ``group`` was asked for. When it exceeds the members listed under
    ``groups[id]``, the rest were capped away — the count is still the truth."""

@dataclass
class SearchQuery(_Schema):
    """The filter/sort/page parameters, also storable as a bulk selector."""

    q: str = ""
    query: str = ""
    """Alias of ``q``, so a stored selector round-trips unchanged."""
    tags: list[str] = field(default_factory=list)
    dupes_only: bool = False
    """Filter to records that have at least one near-duplicate."""
    group: bool = False
    """Fold each near-duplicate cluster into a single row, its members returned
    under ``groups``. Together with ``dupes_only`` these are the two search
    shapes that pay for the all-pairs scan."""
    sort: Literal["relevance", "recent", "most_used", "az"] = "relevance"
    mode: Literal["all", "any"] = "all"
    offset: int = 0
    limit: int = 50
    threshold: float | None = None
    """Similarity threshold; null falls back to the persisted setting."""
    match_id: str = ""
    """Badge every hit with its similarity to this record."""

@dataclass
class SearchResponse(Envelope):
    total: int
    """Rows to page over: clusters and singletons when ``group`` is on, records
    otherwise. This is what ``offset`` counts in."""
    offset: int
    limit: int
    threshold: float
    took_ms: float
    dupes_partial: bool
    """True when `dupes_only` could not be applied and the filter was skipped."""
    fallback: bool
    """True when the query missed and the infix/edit-1 vocabulary scan ran."""
    hits: list[SearchHit]
    record_total: int
    """Records behind those rows. Equal to ``total`` unless ``group`` folded
    clusters — that is the number a "select all filtered" bulk op will act on."""
    groups: dict[str, list[SearchHit]]
    """``{representative id: the rest of its cluster}``, for the hits on this
    page that have any. A flat sibling map rather than members nested inside
    the hit, because a self-referential ``SearchHit`` is not something the
    OpenAPI generator can render."""

@dataclass
class AutocompleteQuery(_Schema):
    word_prefix: str = ""
    phrase_prefix: str = ""
    limit: int = 8
    """Result count, clamped to 1–20."""

@dataclass
class AutocompleteSuggestion(_Schema):
    text: str
    """An individual word or saved phrase containing at most three words."""
    scope: Literal["word", "phrase"]
    source_count: int
    """Distinct current prompts containing this keyword."""

@dataclass
class AutocompleteResponse(Envelope):
    suggestions: list[AutocompleteSuggestion]
