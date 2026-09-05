"""The tag list for the filter rail."""

from dataclasses import dataclass

from .base import Envelope, _Schema


@dataclass
class TagCount(_Schema):
    tag: str
    count: int

@dataclass
class TaxonomyResponse(Envelope):
    tags: list[TagCount]
    total: int
