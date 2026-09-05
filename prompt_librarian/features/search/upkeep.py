"""Keeping the cached search index in step with library changes."""

from ...shared.events import Change
from .cache import invalidate_index


def on_change(_change: Change) -> None:
    """Drop the cached index; it is keyed by revision, so this only frees memory."""
    invalidate_index()
