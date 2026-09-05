"""Edits over many records: delete, retag, merge."""

from collections.abc import Iterable

from ...shared import entries
from ...shared.clock import now_iso
from ...shared.errors import SameRecordError
from ...shared.library import Library
from ...shared.records import Record, clean_tags
from .get import get_prompt
from .merge import merge_prompts


def bulk_delete(lib: Library, ids: Iterable[str]) -> int:
    """Delete every existing id in one transaction. Returns how many were removed."""
    with lib.write("bulk_delete") as work:
        removed = sum(entries.remove(work, pid) for pid in dict.fromkeys(ids))
        work.skip = not removed
    return removed


def bulk_retag(
    lib: Library,
    ids: Iterable[str],
    add: list[str] | None = None,
    remove: list[str] | None = None,
    replace: list[str] | None = None,
) -> int:
    """Add/remove tags, or ``replace`` them outright, in one transaction.

    Returns the number of records whose tags actually changed.
    """
    stamp = now_iso()
    with lib.write("bulk_retag") as work:
        touched = 0
        for rec in entries.get_many(work.con, list(ids)):
            tags = _retagged(rec["tags"], add, remove, replace)
            if tags != rec["tags"]:
                rec["tags"], rec["updated"] = tags, stamp
                entries.put(work, rec)
                touched += 1
        work.skip = not touched
    return touched


def _retagged(
    tags: list[str], add: list[str] | None, remove: list[str] | None, replace: list[str] | None
) -> list[str]:
    if replace is not None:
        return clean_tags(replace)
    dropped = set(clean_tags(remove or []))
    kept = [tag for tag in tags if tag not in dropped]
    return clean_tags(kept + [tag for tag in clean_tags(add or []) if tag not in kept])


def bulk_merge(lib: Library, ids: Iterable[str], winner: str | None = None) -> Record | None:
    """Merge every id into ``winner`` (the first id by default), one merge at a time.

    Raises:
        SameRecordError: Fewer than two distinct ids.
    """
    order = list(dict.fromkeys(ids))
    if len(order) < 2:
        raise SameRecordError("a merge needs at least two distinct records")
    keeper = winner if winner in order else order[0]
    for pid in order:
        if pid != keeper:
            merge_prompts(lib, keeper, pid)
    return get_prompt(lib, keeper)
