"""Reading, writing and counting single prompt records."""

from dataclasses import dataclass, field

from .base import Envelope, Prompt, _Schema


@dataclass
class PromptMeta(_Schema):
    """The subset of a record a node face shows."""

    label: str
    rating: int
    used: int
    tags: list[str]
    near_dupes: int
    updated: str

@dataclass
class GetPromptQuery(_Schema):
    id: str

@dataclass
class MetaBody(_Schema):
    ids: list[str]
    threshold: float | None = None

@dataclass
class MetaResponse(Envelope):
    meta: dict[str, PromptMeta]
    """Keyed by id; unknown ids are simply absent."""

@dataclass
class CreateBody(_Schema):
    body: str = ""
    tags: list[str] = field(default_factory=list)
    rating: int = 0
    notes: str = ""
    pinned: bool = False

@dataclass
class UpdateBody(_Schema):
    """A partial update: every omitted field is left as it is."""

    id: str
    body: str | None = None
    tags: list[str] | None = None
    rating: int | None = None
    notes: str | None = None
    pinned: bool | None = None
    snapshot: bool = True
    """Snapshot the current body into the history first."""
    expect_updated: str | None = None
    """The record's `updated` as the client last saw it; a mismatch is a 409."""

@dataclass
class RateBody(_Schema):
    id: str
    rating: int

@dataclass
class PromptIdBody(_Schema):
    id: str

@dataclass
class DeleteResponse(Envelope):
    deleted: bool
    id: str

@dataclass
class UsageBody(_Schema):
    id: str
    body: str | None = None
    """Checked against the stored body; a mismatch counts nothing."""

@dataclass
class UsageResponse(Envelope):
    prompt: Prompt | None
    """Null when nothing was counted."""
    counted: bool

@dataclass
class MergeBody(_Schema):
    """``*_id`` aliases are accepted for both sides."""

    winner: str = ""
    winner_id: str = ""
    loser: str = ""
    loser_id: str = ""

@dataclass
class MergeNewBody(_Schema):
    """``body`` is required: a synthesized record has no defensible default."""

    body: str
    a: str = ""
    a_id: str = ""
    b: str = ""
    b_id: str = ""
