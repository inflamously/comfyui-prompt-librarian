"""Near-duplicate checks, the library-wide scan, diffs and keep-both decisions."""

from dataclasses import dataclass
from typing import Literal

from .base import Envelope, _Schema


@dataclass
class DupeMatch(_Schema):
    """One near-duplicate of the body that was asked about."""

    id: str
    label: str
    score: float
    pct: int
    summary: str
    """Human diff summary, empty when ``summaries`` was false."""
    preview: str
    used: int
    updated: str
    ignored: bool
    """True when this pair carries a "keep both" decision. The match is still
    reported — muting is the save gate's business, not a claim that the
    duplicate went away — and it is the caller that acts on the flag."""

@dataclass
class DiffChunk(_Schema):
    """One word-level opcode, ``equal`` runs included."""

    op: Literal["equal", "replace", "insert", "delete"]
    a_start: int
    a_end: int
    b_start: int
    b_end: int
    a_tokens: list[str]
    b_tokens: list[str]

@dataclass
class DupesAllQuery(_Schema):
    threshold: float | None = None
    exhaustive: bool = False
    """Skip the length prefilter and blocking index; slow and rarely wanted."""

@dataclass
class DupesAllResponse(Envelope):
    threshold: float
    exhaustive: bool
    counts: dict[str, int]
    """Near-duplicates per record id. Every one of them — see ``ignored``."""
    groups: list[list[str]]
    """Connected clusters of ids."""
    pairs: dict[str, list[str]]
    """Each id's partners, both directions present."""
    ignored: list[list[str]]
    """The "keep both" pairs, reported ALONGSIDE the counts rather than
    subtracted from them, so a client can mark a muted pair without having to
    guess why a number came back smaller than the library looks."""

@dataclass
class DupesBody(_Schema):
    """The body to check, as raw ``text`` or as the ``id`` of a record."""

    text: str | None = None
    id: str | None = None
    exclude_id: str | None = None
    """Required when saving an existing record, or it matches itself at 100%."""
    threshold: float | None = None
    limit: int = 10
    summaries: bool = True

@dataclass
class DupesResponse(Envelope):
    matches: list[DupeMatch]
    threshold: float

@dataclass
class CompareBody(_Schema):
    """Each side is given as ``<k>_text``, or as ``<k>_id`` / ``<k>``."""

    a: str = ""
    a_id: str = ""
    a_text: str | None = None
    b: str = ""
    b_id: str = ""
    b_text: str | None = None

@dataclass
class CompareResponse(Envelope):
    score: float
    pct: int
    summary: str
    diff: list[DiffChunk]

@dataclass
class IgnoreDupeBody(_Schema):
    """The pair, as ``a``/``b`` or as ``id``/``other``."""

    a: str = ""
    b: str = ""
    id: str = ""
    other: str = ""
    unignore: bool = False

@dataclass
class IgnoreDupeResponse(Envelope):
    changed: bool
    """False when the pair was already in that state."""
    ignored: bool
