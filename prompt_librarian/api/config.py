"""Constants for the ``/prompt_librarian/*`` route layer.

Everything here is a decision the rest of the package reads and never
rewrites: where the routes are mounted, what the frontend is told it can do,
how far a "select all filtered" query may reach, and how a store exception
becomes an HTTP status. Keeping them in one module means the answer to "what
does the panel see?" is a single file, not a grep across the handlers.
"""

from ..store import (
    BodyTooLargeError,
    ConflictError,
    NotFoundError,
    ReadOnlyError,
    SameRecordError,
    StoreWriteError,
)

PREFIX = "/prompt_librarian"

#: "select all filtered" resolves a stored query to ids; this caps that.
BULK_QUERY_LIMIT = 100000

#: What the frontend probes on startup to decide which panels to build.
CAPABILITIES = {
    "search": True,
    "versions": True,
    "diff": True,
    "wildcards": True,
    "snippets": True,
    "bulk": True,
    "dupes": True,
    # No soft delete: `delete` removes the record. Versions are the undo story,
    # and a trash bin nobody empties is a second source of near-duplicates.
    "soft_delete": False,
}

# Ordered most-specific first; the first isinstance() match wins. ValueError is
# last because several store errors would otherwise be shadowed by it.
_ERROR_MAP = (
    (NotFoundError, 404, "not_found"),
    (BodyTooLargeError, 413, "too_large"),
    (ReadOnlyError, 409, "readonly"),
    (ConflictError, 409, "conflict"),
    (SameRecordError, 400, "same_record"),
    (StoreWriteError, 500, "write_failed"),
    (ValueError, 400, "bad_request"),
)
