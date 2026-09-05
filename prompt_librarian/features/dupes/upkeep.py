"""Keeping cached duplicate scans in step with library changes.

Subscribed to the library's change bus, so writes from the API, the node and
bulk edits all take the same path; routes never patch caches themselves.
"""

from collections.abc import Callable

from ...shared.events import Change
from . import cache
from .scanning import patch
from .source import LibraryDupeSource

#: Writes touching more records than this rescan instead of patching one by one.
PATCH_LIMIT = 25


def patcher(source: LibraryDupeSource) -> Callable[[Change], None]:
    """A change subscriber that keeps ``source``'s cached all-pairs scans current."""

    def on_change(change: Change) -> None:
        if not change.bodies_changed:
            # Usage, ratings, tags, settings: similarity reads bodies only.
            cache.carry_forward(change.old_rev, change.new_rev)
        elif len(change.ids) > PATCH_LIMIT:
            cache.invalidate()
        else:
            _patch_each(source, change)

    return on_change


def _patch_each(source: LibraryDupeSource, change: Change) -> None:
    """Patch every cached threshold across this commit, one record at a time."""
    for threshold, exhaustive in cache.cached_all_settings(change.old_rev):
        base = change.old_rev
        for pid in change.ids:
            record = change.records.get(pid)
            result = patch(
                {"id": pid},
                record,
                threshold,
                old_rev=base,
                new_rev=change.new_rev,
                source=source,
                exhaustive=exhaustive,
            )
            if result is None:
                break
            base = change.new_rev
