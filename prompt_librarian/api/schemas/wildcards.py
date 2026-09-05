"""Wildcard files and seeded resolution previews."""

from dataclasses import dataclass
from typing import Literal

from .base import Envelope, _Schema


@dataclass
class WildcardPick(_Schema):
    """One substitution a resolve pass made."""

    kind: Literal["wildcard", "snippet", "choice"]
    name: str
    value: str
    count: int | None = None
    """How many options were on offer — wildcard files only."""

@dataclass
class WildcardsResponse(Envelope):
    names: list[str]
    dir: str
    signature: str
    """sha1 over every wildcard file's (name, mtime, size)."""

@dataclass
class ResolveBody(_Schema):
    text: str
    seed: int = 0
    n: int = 1
    """Samples to draw, clamped to 1..50."""

@dataclass
class ResolveResponse(Envelope):
    text: str
    """The first sample, the one whose picks are reported."""
    samples: list[str]
    picks: list[WildcardPick]
    missing: list[str]
    warnings: list[str]
