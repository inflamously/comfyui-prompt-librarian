"""Merging near-duplicates: into one of them, or into a new third record."""

import copy

from ...shared import entries, meta
from ...shared.clock import new_id, now_iso
from ...shared.errors import NotFoundError, SameRecordError
from ...shared.library import Library, Write
from ...shared.records import (
    MERGE_VERSIONS_KEPT,
    Record,
    clean_record,
    merge_fields,
    trim_versions,
)


def _require(work: Write, pid: str) -> Record:
    rec = entries.get(work.con, pid)
    if rec is None:
        raise NotFoundError(f"no prompt with id {pid!r}")
    return rec


def _absorb_history(target: Record, source: Record, stamp: str) -> None:
    """Append ``source``'s recent versions, then its current body, tagged with its id."""
    for entry in source.get("versions", [])[-MERGE_VERSIONS_KEPT:]:
        target["versions"].append({**entry, "src": source["id"]})
    target["versions"].append(
        {"body": source["body"], "ts": source.get("updated", "") or stamp, "src": source["id"]}
    )


def merge_prompts(lib: Library, winner_id: str, loser_id: str) -> Record:
    """Merge ``loser_id`` into ``winner_id`` and delete the loser, in one transaction.

    The winner keeps its id and body; usage adds up, tags union, and the loser's
    recent history and body join the winner's versions.

    Raises:
        SameRecordError: The two ids are the same.
        NotFoundError: Either id is unknown.
    """
    if winner_id == loser_id:
        raise SameRecordError("cannot merge a record into itself")
    with lib.write("merge") as work:
        winner, loser = _require(work, winner_id), _require(work, loser_id)
        _absorb_history(winner, loser, "")
        merge_fields(winner, loser)
        winner["updated"] = now_iso()
        trim_versions(winner, meta.version_cap(work.con))
        entries.put(work, winner)
        entries.remove(work, loser_id)
    return copy.deepcopy(winner)


def merge_into_new(lib: Library, a_id: str, b_id: str, body: str) -> Record:
    """Create a third record with ``body`` that absorbs both inputs, then delete both.

    Raises:
        SameRecordError: The two ids are the same.
        ValueError: ``body`` is blank; neither input is a safe default.
        NotFoundError: Either id is unknown.
    """
    if a_id == b_id:
        raise SameRecordError("cannot merge a record with itself")
    if not str(body or "").strip():
        raise ValueError("merge_new requires a body")
    with lib.write("merge_new") as work:
        first, second = _require(work, a_id), _require(work, b_id)
        stamp = now_iso()
        rec = clean_record(
            {**_carried(first), "id": new_id(), "body": body, "updated": stamp, "versions": []}
        )
        for source in (first, second):
            _absorb_history(rec, source, stamp)
        merge_fields(rec, second)
        rec["updated"] = stamp
        trim_versions(rec, meta.version_cap(work.con))
        entries.put(work, rec)
        entries.remove(work, a_id)
        entries.remove(work, b_id)
    return copy.deepcopy(rec)


def _carried(first: Record) -> Record:
    """What a merged-into-new record inherits from the first input."""
    keys = ("tags", "rating", "used", "last_run", "created", "notes", "pinned")
    return {key: copy.deepcopy(first[key]) for key in keys}
