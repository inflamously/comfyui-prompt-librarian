"""Whether the dictionary has been downloaded, and how big it is."""

import sqlite3

from . import _store


def dictionary_status(root: str) -> dict[str, object]:
    """``{"installed", "words", "source"}``; a damaged file reads as not installed."""
    if not _store.installed(root):
        return {"installed": False, "words": 0, "source": ""}
    try:
        with _store.read(root) as con:
            meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
    except sqlite3.Error:
        return {"installed": False, "words": 0, "source": ""}
    return {"installed": True, "words": int(meta.get("words", 0)), "source": meta.get("source", "")}
