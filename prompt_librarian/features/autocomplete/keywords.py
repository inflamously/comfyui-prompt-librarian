"""Every learned word and short phrase, most used first."""

from ...shared.db import schema
from ...shared.library import Library

KEYWORDS_SQL = """SELECT text, source_count FROM autocomplete_keywords
    WHERE source_count > 0 ORDER BY source_count DESC, keyword"""


def list_keywords(lib: Library) -> list[tuple[str, int]]:
    """``(spelling, prompts using it)`` for the whole vocabulary; empty when unreadable."""
    if not lib.exists():
        return []
    with lib.read() as con:
        if schema.newer_schema(con):
            return []
        return [(row["text"], row["source_count"]) for row in con.execute(KEYWORDS_SQL)]
