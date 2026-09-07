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

CAPABILITIES = {
    "search": True,
    "versions": True,
    "diff": True,
    "wildcards": True,
    "snippets": True,
    "bulk": True,
    "dupes": True,
    "storage": True,
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
