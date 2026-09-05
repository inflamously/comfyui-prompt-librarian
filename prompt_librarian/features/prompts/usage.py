"""Counting a run of a saved prompt."""

import copy

from ...shared import entries
from ...shared.clock import now_iso
from ...shared.coerce import as_int, as_str
from ...shared.library import Library
from ...shared.records import Record


def record_usage(lib: Library, pid: str, body: object = None) -> Record | None:
    """Count one run; ``None`` when nothing was counted.

    Only a run whose ``body`` matches the saved body (ignoring surrounding
    whitespace) counts, so unsaved edits cannot inflate usage. ``updated`` is
    left alone: a run is not an edit, and bumping it would make an open editor's
    next save look like a conflict.
    """
    with lib.write("usage") as work:
        rec = entries.get(work.con, pid)
        if rec is None or (body is not None and as_str(body).strip() != rec["body"].strip()):
            work.skip = True
            return None
        rec["used"] = max(0, as_int(rec.get("used", 0))) + 1
        rec["last_run"] = now_iso()
        entries.put(work, rec)
    return copy.deepcopy(rec)
