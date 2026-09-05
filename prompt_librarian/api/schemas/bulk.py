"""Edits over a selection of records."""

from dataclasses import dataclass, field

from .base import Envelope, Prompt, _Schema
from .search import SearchQuery


@dataclass
class BulkTarget(_Schema):
    """The selection every `/bulk/*` body takes.

    "Select all filtered" over a large library must not ship every id through
    the browser, so the frontend may store the ``query`` instead and let the
    server re-run it.
    """

    ids: list[str] = field(default_factory=list)
    query: SearchQuery | None = None

@dataclass
class BulkRetagBody(BulkTarget):
    add: list[str] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    replace: list[str] | None = None
    """Replaces the whole tag set; `add`/`remove` are ignored when it is given."""

@dataclass
class BulkMergeBody(BulkTarget):
    winner: str = ""
    """Defaults to the first selected id."""

@dataclass
class BulkCountResponse(Envelope):
    count: int
    ids: list[str]
    """The selection the query resolved to."""

@dataclass
class BulkMergeResponse(Envelope):
    prompt: Prompt
    ids: list[str]
