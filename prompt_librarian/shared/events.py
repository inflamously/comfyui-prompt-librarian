"""Change events: what a committed write did, for caches and the websocket.

A write reads the previous database revision inside its locked transaction, so
``old_rev -> new_rev`` names exactly the commit that happened; nothing else can
land in between. Subscribers use it to carry caches forward or drop them.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("prompt-librarian")

#: Websocket event names. The frontend listens for these; renaming breaks it.
EVENT_CHANGED = "prompt_librarian.changed"
EVENT_USED = "prompt_librarian.used"


@dataclass(frozen=True)
class Change:
    """One committed write.

    Attributes:
        op: What happened, e.g. ``"create"``, ``"usage"``, ``"bulk_retag"``.
        ids: Record ids the write touched.
        old_rev: Database revision the write started from.
        new_rev: Database revision the write committed.
        bodies_changed: False when no body and no id changed (usage, rating,
            tags, settings): similarity results are still exact.
        records: The new record per id, or ``None`` for a deleted id.
    """

    op: str
    ids: tuple[str, ...] = ()
    old_rev: int = 0
    new_rev: int = 0
    bodies_changed: bool = True
    records: dict[str, Any] = field(default_factory=dict)


Subscriber = Callable[[Change], None]


class EventBus:
    """Synchronous fan-out of committed changes.

    A failing subscriber is logged, never raised: the write it reports has
    already committed. Subscribing the same function twice is a no-op.
    """

    def __init__(self) -> None:
        """Start with no subscribers."""
        self._subscribers: list[Subscriber] = []

    def subscribe(self, fn: Subscriber) -> Callable[[], None]:
        """Register ``fn`` (once); returns a function that unregisters it."""
        if fn not in self._subscribers:
            self._subscribers.append(fn)

        def unsubscribe() -> None:
            if fn in self._subscribers:
                self._subscribers.remove(fn)

        return unsubscribe

    def emit(self, change: Change) -> None:
        """Deliver ``change`` to every subscriber, in registration order."""
        for fn in list(self._subscribers):
            try:
                fn(change)
            except Exception:
                log.exception("[prompt-librarian] change subscriber failed for %s", change.op)
