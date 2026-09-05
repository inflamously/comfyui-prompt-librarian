"""Shapes every group builds on: the envelope, errors, and the prompt record."""

from dataclasses import dataclass
from typing import Literal


class _Schema:
    """Base for every declaration here — turns attribute docstrings into docs.

    ``ConfigDict`` is only a ``TypedDict``, so the config can be a plain dict
    literal and this module stays free of the pydantic import.
    """

    __pydantic_config__ = {"use_attribute_docstrings": True}

@dataclass
class Envelope(_Schema):
    """Merged into every response, errors included."""

    rev: int
    """The store revision this response was built from."""

@dataclass
class Version(_Schema):
    """One entry in a record's history."""

    body: str
    ts: str
    src: str | None
    """What produced the snapshot, or null for an ordinary edit."""

@dataclass
class VersionPreview(_Schema):
    """A version without its body — what the history list renders."""

    index: int
    label: str
    """Derived from the snapshotted body; empty for an empty one."""
    ts: str
    src: str | None
    chars: int
    """Length of the full body this preview was cut from."""
    preview: str

@dataclass
class Prompt(_Schema):
    """A library record.

    No name: a record *is* its body. Every response that needs a handle for one
    carries a derived ``label`` instead, and this type deliberately does not —
    it is also the shape ``/export`` writes and ``/import`` reads, and a
    derived field in a file would be a stored name again by another route.
    """

    id: str
    """``uuid4().hex``, stable across edits and never a content hash."""
    body: str
    tags: list[str]
    rating: int
    used: int
    """Times this exact saved body has been run."""
    last_run: str
    created: str
    updated: str
    """Also the concurrency token: pass it back as ``expect_updated``."""
    notes: str
    pinned: bool
    versions: list[Version]

@dataclass
class Error(Envelope):
    """Mirrors ``config._ERROR_MAP``; `internal` is the guard's fallback."""

    error: str
    code: Literal["not_found", "too_large", "readonly", "conflict",
                  "same_record", "write_failed", "bad_request", "internal"]
    """Branch on this, never on the prose."""

@dataclass
class PromptResponse(Envelope):
    prompt: Prompt
    label: str
    """The record's derived handle. Beside the record rather than inside it:
    :class:`Prompt` is also what ``/export`` writes, and a derived field in a
    file on disk would be a stored name again by another route."""
