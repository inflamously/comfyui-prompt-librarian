"""Words in the dictionary that start with what you typed, the common ones first."""

import sqlite3

from . import _store
from .lookup import normalize

#: An upper bound for a prefix range; no lemma contains this code point.
_TOP = "\U0010ffff"

SEARCH_SQL = """SELECT lemma FROM lemmas WHERE lemma >= ? AND lemma < ?
    ORDER BY lemma = ? DESC, senses DESC, length(lemma), lemma LIMIT ?"""


def search_words(root: str, prefix: str, limit: int = 20) -> dict[str, object]:
    """``{"installed", "words"}``: up to ``limit`` lemmas starting with ``prefix``.

    Exact matches come first, then words with more senses, which are the common
    ones, then shorter words.
    """
    key = normalize(prefix)
    if not _store.installed(root):
        return {"installed": False, "words": []}
    if not key:
        return {"installed": True, "words": []}
    try:
        with _store.read(root) as con:
            rows = con.execute(SEARCH_SQL, (key, key + _TOP, key, limit)).fetchall()
    except sqlite3.Error:
        return {"installed": False, "words": []}
    return {"installed": True, "words": [row["lemma"] for row in rows]}
