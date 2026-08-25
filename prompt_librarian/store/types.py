"""Store vocabulary: SQLite limits, events, and deliberate errors.

This module is the bottom of the store slice. It imports nothing from the rest
of the package (and nothing from ComfyUI).

The error classes in particular are **contract**: ``prompt_librarian.api`` maps
them onto HTTP status codes by name, so renaming one silently changes the API.
"""

SCHEMA_VERSION = 1

MAX_BODY_CHARS = 100000
MAX_SNIPPET_NAME_CHARS = 100
MAX_TAG_CHARS = 40
MAX_TAGS = 32

VERSION_CAP = 50
VERSION_BYTES_CAP = 262144  # 256 KB of version bodies per record
MERGE_VERSIONS_KEPT = 5     # of the loser's own history, on merge

DEFAULT_DUPE_THRESHOLD = 0.90

EVENT_CHANGED = "prompt_librarian.changed"
EVENT_USED = "prompt_librarian.used"

# Fields this build no longer keeps. They are scrubbed from imported and loaded
# records without a schema bump because they were never required for identity.
REMOVED_FIELDS = ("category", "name")


# --------------------------------------------------------------------------- #
# Errors — the api layer maps these onto HTTP codes, so the names are contract.
# --------------------------------------------------------------------------- #

class StoreError(Exception):
    """Base class for every error the store raises deliberately."""


class NotFoundError(StoreError):
    """No record / version / snippet with that id or snippet name (HTTP 404)."""


class BodyTooLargeError(StoreError):
    """A body exceeds ``MAX_BODY_CHARS``. Bodies are rejected, never truncated (413)."""


class ReadOnlyError(StoreError):
    """The library on disk has a newer ``schema`` than this build understands (409)."""


class StoreWriteError(StoreError):
    """The library could not be written to disk (500)."""


class SameRecordError(StoreError):
    """A merge was asked to merge a record with itself (400)."""


class ConflictError(StoreError):
    """``expect_updated`` did not match the record's current ``updated`` (409)."""
