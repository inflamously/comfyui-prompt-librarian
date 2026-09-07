"""Revision keys prevent stale cache hits. Invalidate obsolete entries and
patch single-record changes to avoid rebuilding all-pairs results.
"""

import logging

from .. import dedupe, search
from ..store import STORE
from .utils import _rev, _threshold

log = logging.getLogger(__name__)

_SINGLE_RECORD_OPS = frozenset(("create", "update", "delete", "usage"))


def _on_change(op):
    """Store listener wired once at registration. Must never raise."""
    try:
        search.invalidate_index()
        if op not in _SINGLE_RECORD_OPS:
            # Bulk / merge / import / taxonomy edits touch too much to patch.
            dedupe.invalidate()
    except Exception:  # pragma: no cover - a broken index must not fail a write
        log.debug("[prompt-librarian] index invalidation failed", exc_info=True)


def _patch_dupes(old_rec, new_rec, old_rev):
    """Patch every cached threshold onto the new revision, not just the persisted
    setting, to avoid cold scans during grouped searches.
    """
    new_rev = _rev()
    settings = dedupe.cached_all_settings(old_rev)
    if not settings:
        settings = [(_threshold(None), False)]
    try:
        for threshold, exhaustive in settings:
            result = dedupe.patch(old_rec, new_rec, threshold,
                                  old_rev=old_rev, new_rev=new_rev,
                                  source=STORE, exhaustive=exhaustive)
            if result is None:
                # Nothing cached to patch at this threshold; the next caller
                # computes it from scratch and there is nothing stale to drop.
                continue
    except Exception:  # pragma: no cover - fall back to the safe path
        log.debug("[prompt-librarian] dupe patch failed; invalidating", exc_info=True)
        dedupe.invalidate()
