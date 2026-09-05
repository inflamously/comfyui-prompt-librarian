"""Completing the word or short phrase being typed, from saved prompt bodies."""

from ...shared.db import schema
from ...shared.library import Library
from . import vocabulary

MAX_SUGGESTIONS = 20


def suggest(
    lib: Library, word_prefix: str = "", phrase_prefix: str = "", limit: int = 8
) -> list[dict[str, object]]:
    """Up to ``limit`` completions, most used first; none for a newer-schema library."""
    if not lib.exists():
        return []
    with lib.read() as con:
        if schema.newer_schema(con):
            return []
        limit = max(1, min(MAX_SUGGESTIONS, limit))
        return vocabulary.suggest(con, word_prefix, phrase_prefix, limit)
