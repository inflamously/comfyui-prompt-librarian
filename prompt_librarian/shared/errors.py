"""Library errors. Their class names map to HTTP statuses in ``api/config.py``."""


class StoreError(Exception):
    """Base class for every error the library raises deliberately."""


class NotFoundError(StoreError):
    """No record / version / snippet with that id or name (HTTP 404)."""


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
