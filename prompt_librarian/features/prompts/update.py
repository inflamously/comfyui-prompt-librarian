"""Editing a record, with optimistic concurrency and version snapshots."""

import copy
from collections.abc import Callable

from ...shared import entries, meta
from ...shared.clock import now_iso
from ...shared.coerce import as_str
from ...shared.errors import ConflictError, NotFoundError
from ...shared.library import Library
from ...shared.records import Record, clean_record, trim_versions

_FIELDS = ("body", "tags", "rating", "notes", "pinned")


def update_prompt(
    lib: Library,
    pid: str,
    body: str | None = None,
    tags: list[str] | None = None,
    rating: int | None = None,
    notes: str | None = None,
    pinned: bool | None = None,
    snapshot: bool = True,
    expect_updated: str | None = None,
) -> Record:
    """Change the fields given (``None`` leaves one alone) and return the record.

    ``expect_updated`` is checked inside the write transaction, so another tab
    or process cannot slip a change in between. The pre-edit body becomes a
    version only when the body changed and ``snapshot`` is set; the stored
    ``version_cap`` setting bounds the history.

    Raises:
        NotFoundError: Unknown id.
        ConflictError: ``expect_updated`` is not the stored ``updated``.
        BodyTooLargeError: Nothing is written.
    """
    with lib.write("update") as work:
        rec = entries.get(work.con, pid)
        if rec is None:
            raise NotFoundError(f"no prompt with id {pid!r}")
        if expect_updated is not None and as_str(expect_updated) != rec.get("updated", ""):
            raise ConflictError(
                f"record {pid} changed since it was loaded "
                f"({expect_updated} != {rec.get('updated', '')})"
            )
        changes = {"body": body, "tags": tags, "rating": rating, "notes": notes, "pinned": pinned}
        edited = _apply(rec, changes, snapshot, lambda: meta.version_cap(work.con))
        if edited is None:
            work.skip = True
            return rec
        entries.put(work, edited)
    return copy.deepcopy(edited)


def _apply(
    rec: Record, changes: dict[str, object], snapshot: bool, cap: Callable[[], int]
) -> Record | None:
    """The edited record, or ``None`` when nothing would change.

    Only a body snapshot grows the history, so only then is the stored cap read.
    """
    wanted = {key: value for key, value in changes.items() if key in _FIELDS and value is not None}
    cleaned = clean_record({**rec, **wanted})
    if all(cleaned[key] == rec[key] for key in _FIELDS):
        return None
    edited = copy.deepcopy(rec)
    grows = snapshot and cleaned["body"] != rec["body"]
    if grows:
        edited["versions"].append(
            {"body": rec["body"], "ts": rec.get("updated", "") or now_iso(), "src": None}
        )
    for key in _FIELDS:
        edited[key] = cleaned[key]
    edited["updated"] = now_iso()
    if grows:
        trim_versions(edited, cap())
    return edited


def rate_prompt(lib: Library, pid: str, rating: int) -> Record:
    """Set a record's 0..5 rating (clamped). Never snapshots a version."""
    return update_prompt(lib, pid, rating=rating, snapshot=False)
