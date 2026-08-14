"""Keeping the search and dedupe caches honest across a write.

Two functions, neither of them a route and both called from outside this
module: :func:`_on_change` is the store listener :mod:`.registration` wires
once at startup, and :func:`_patch_dupes` is what the single-record write
handlers in :mod:`.routes.prompts` call once a mutation has landed.

Both caches are rev-keyed (search on ``rev``, dedupe on
``(rev, threshold, ...)``) so a bumped rev is already a guaranteed miss and
*stale data is structurally impossible*. What is here is memory hygiene plus
the incremental fast path: ``dedupe.patch()`` re-keys an all-pairs result onto
the new rev for ~20 ms instead of the 0.5-2 s a cold rebuild costs.
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
    """Incrementally re-key the all-pairs cache after a single-record write."""
    try:
        result = dedupe.patch(old_rec, new_rec, _threshold(None),
                              old_rev=old_rev, new_rev=_rev(), source=STORE)
        if result is None:
            dedupe.invalidate()
    except Exception:  # pragma: no cover - fall back to the safe path
        log.debug("[prompt-librarian] dupe patch failed; invalidating", exc_info=True)
        dedupe.invalidate()
