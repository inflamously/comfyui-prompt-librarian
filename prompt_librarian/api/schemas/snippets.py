"""Named ``[[snippet]]`` bodies."""

from dataclasses import dataclass
from typing import Literal

from .base import Envelope, _Schema


@dataclass
class Snippet(_Schema):
    """A reusable ``[[snippet]]`` body."""

    body: str
    updated: str

@dataclass
class SnippetsResponse(Envelope):
    snippets: dict[str, Snippet]

@dataclass
class SnippetBody(_Schema):
    name: str
    op: Literal["set", "delete"] = "set"
    body: str = ""
