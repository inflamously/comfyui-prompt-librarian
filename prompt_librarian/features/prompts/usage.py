"""Counting a run of a saved prompt."""

import copy

from ...shared import entries
from ...shared.clock import now_iso
from ...shared.coerce import as_int, as_str
from ...shared.library import Library
from ...shared.records import Record


def record_usage(lib: Library, pid: str, body: object = None) -> Record | None:
    """Count one run whose ``body`` matches the saved one; ``None`` when nothing was counted."""
    with lib.write("usage") as work:
        rec = entries.get(work.con, pid)
        if rec is None or (body is not None and as_str(body).strip() != rec["body"].strip()):
            work.skip = True
            return None
        rec["used"] = max(0, as_int(rec.get("used", 0))) + 1
        rec["last_run"] = now_iso()
        # ``updated`` stays: bumping it would make an open editor's next save conflict.
        entries.put(work, rec)
    return copy.deepcopy(rec)
