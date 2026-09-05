"""The tags in use, with counts, for the filter rail."""

from ...shared import entries
from ...shared.errors import StoreWriteError
from ...shared.library import Library


def tag_counts(lib: Library) -> list[dict[str, object]]:
    """``[{"tag", "count"}]``, most used first; empty when unreadable."""
    if not lib.exists():
        return []
    try:
        with lib.read() as con:
            return [{"tag": tag, "count": n} for tag, n in entries.tag_counts(con)]
    except StoreWriteError:
        return []


def taxonomy(lib: Library) -> dict[str, object]:
    """The tags with counts, plus the total number of records."""
    total = 0
    if lib.exists():
        try:
            with lib.read() as con:
                total = entries.count(con)
        except StoreWriteError:
            total = 0
    return {"tags": tag_counts(lib), "total": total}
