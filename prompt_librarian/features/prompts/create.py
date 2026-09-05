"""Creating a record."""

import copy

from ...shared import entries
from ...shared.clock import new_id, now_iso
from ...shared.library import Library
from ...shared.records import Record, clean_record


def create_prompt(
    lib: Library,
    body: str = "",
    tags: list[str] | None = None,
    rating: int = 0,
    notes: str = "",
    pinned: bool = False,
) -> Record:
    """Validate and store a new record; returns it.

    Raises:
        BodyTooLargeError: Before anything is written.
    """
    stamp = now_iso()
    rec = clean_record(
        {
            "id": new_id(),
            "body": body,
            "tags": tags or [],
            "rating": rating,
            "used": 0,
            "last_run": "",
            "created": stamp,
            "updated": stamp,
            "notes": notes,
            "pinned": pinned,
            "versions": [],
        }
    )
    with lib.write("create") as work:
        entries.put(work, rec)
    return copy.deepcopy(rec)
