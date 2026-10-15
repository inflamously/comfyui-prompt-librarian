"""Change events: what a committed write did, for caches and the websocket."""

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
    """One committed write."""

    op: str
    ids: tuple[str, ...] = ()
    old_rev: int = 0
    new_rev: int = 0
    bodies_changed: bool = True  # False when no body or id changed: similarity stays exact
    records: dict[str, Any] = field(default_factory=dict)


Subscriber = Callable[[Change], None]


class EventBus:
    """Synchronous fan-out of committed changes; failing subscribers are logged."""

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
