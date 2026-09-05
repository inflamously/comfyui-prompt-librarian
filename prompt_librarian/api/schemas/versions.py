"""A record's version history."""

from dataclasses import dataclass

from .base import Envelope, Version, VersionPreview, _Schema


@dataclass
class ListVersionsQuery(_Schema):
    id: str
    chars: int = 160
    """Preview length. Bodies are never returned here at any value."""

@dataclass
class VersionsResponse(Envelope):
    id: str
    versions: list[VersionPreview]

@dataclass
class GetVersionQuery(_Schema):
    id: str
    index: int = -1

@dataclass
class VersionResponse(Envelope):
    id: str
    index: int
    version: Version

@dataclass
class RestoreVersionBody(_Schema):
    id: str
    index: int = -1
