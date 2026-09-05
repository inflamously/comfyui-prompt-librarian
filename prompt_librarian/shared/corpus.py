"""The search and duplicate-detection projection of each record.

Normalized body and tag text live on ``entries`` (``body_norm``, ``tags_norm``,
``sim_norm``); this module owns the ``terms`` postings and the ``prompt_fts``
FTS5 table, both rewritten inside the transaction that writes the record. It
also reads the projection back, for search and dupes alike.
"""

import json
import sqlite3
from typing import Any

from .coerce import as_str
from .text import normalize

SIM_MAX_CHARS = 4000
HEAD_TOKENS = 12

_DDL = (
    """CREATE TABLE IF NOT EXISTS terms (
        prompt_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        term TEXT NOT NULL,
        in_body INTEGER NOT NULL,
        in_tag INTEGER NOT NULL,
        in_head INTEGER NOT NULL,
        in_sim INTEGER NOT NULL,
        PRIMARY KEY(prompt_id, term)
    )""",
    "CREATE INDEX IF NOT EXISTS terms_lookup ON terms(term, prompt_id)",
)
_FTS_DDL = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS prompt_fts "
    "USING fts5(id UNINDEXED, body, tags, "
    "tokenize='unicode61 remove_diacritics 2 tokenchars ''_''')"
)


def projection(rec: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    """The list entry plus the normalized forms search and dedupe read."""
    body = as_str(rec.get("body", ""))
    body_norm = normalize(body)
    return {
        **entry,
        "id": as_str(rec.get("id")),
        "body": body,
        "body_norm": body_norm,
        "tags_norm": " ".join(filter(None, (normalize(tag) for tag in rec.get("tags") or ()))),
        "sim_norm": body_norm[:SIM_MAX_CHARS],
        "notes": as_str(rec.get("notes", "")),
    }


def create(con: sqlite3.Connection) -> bool:
    """Create the corpus tables if missing. Returns whether FTS5 is available."""
    for statement in _DDL:
        con.execute(statement)
    try:
        con.execute(_FTS_DDL)
    except sqlite3.OperationalError:
        return False
    return True


def has_fts(con: sqlite3.Connection) -> bool:
    """Whether the FTS5 table exists (for libraries this build must not alter)."""
    return bool(con.execute("SELECT 1 FROM sqlite_master WHERE name='prompt_fts'").fetchone())


def write(con: sqlite3.Connection, p: dict[str, Any], fts5: bool) -> None:
    """Replace one record's postings and FTS row from its :func:`projection`."""
    con.execute("DELETE FROM terms WHERE prompt_id=?", (p["id"],))
    con.executemany(
        "INSERT INTO terms(prompt_id,term,in_body,in_tag,in_head,in_sim) VALUES(?,?,?,?,?,?)",
        _postings(p),
    )
    if fts5:
        con.execute("DELETE FROM prompt_fts WHERE id=?", (p["id"],))
        con.execute(
            "INSERT INTO prompt_fts(id,body,tags) VALUES(?,?,?)",
            (p["id"], p["body_norm"], p["tags_norm"]),
        )


def _postings(p: dict[str, Any]) -> list[tuple[str, str, int, int, int, int]]:
    body_tokens = p["body_norm"].split()
    body, tags = set(body_tokens), set(p["tags_norm"].split())
    head, sim = set(body_tokens[:HEAD_TOKENS]), set(p["sim_norm"].split())
    return [
        (p["id"], term, int(term in body), int(term in tags), int(term in head), int(term in sim))
        for term in sorted(body | tags)
    ]


def delete(con: sqlite3.Connection, pid: str, fts5: bool) -> None:
    """Drop one record's FTS row; its postings cascade with the ``entries`` row."""
    if fts5:
        con.execute("DELETE FROM prompt_fts WHERE id=?", (pid,))


def clear(con: sqlite3.Connection, fts5: bool) -> None:
    """Drop every posting and FTS row, before a full library replacement."""
    con.execute("DELETE FROM terms")
    if fts5:
        con.execute("DELETE FROM prompt_fts")


#: The ``entries`` columns a projected record is read from.
RECORD_COLUMNS = "id,body,tags_json,rating,used,last_run,created,updated,notes,pinned"


def record_from_row(row: sqlite3.Row) -> dict[str, Any]:
    """A projected record: the current body and list fields, no version history."""
    return {
        "id": row["id"],
        "body": row["body"],
        "tags": json.loads(row["tags_json"]),
        "rating": row["rating"],
        "used": row["used"],
        "last_run": row["last_run"],
        "created": row["created"],
        "updated": row["updated"],
        "notes": row["notes"],
        "pinned": bool(row["pinned"]),
        "versions": [],
    }


def all_records(con: sqlite3.Connection) -> list[dict[str, Any]]:
    """Every projected record, in creation order."""
    rows = con.execute(f"SELECT {RECORD_COLUMNS} FROM entries ORDER BY order_no")
    return [record_from_row(row) for row in rows]


def record(con: sqlite3.Connection, pid: str) -> dict[str, Any] | None:
    """One projected record, or ``None``."""
    row = con.execute(f"SELECT {RECORD_COLUMNS} FROM entries WHERE id=?", (pid,)).fetchone()
    return record_from_row(row) if row else None


def records_by_id(con: sqlite3.Connection, ids: set[str]) -> list[dict[str, Any]]:
    """Projected records for ``ids``, in creation order."""
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    rows = con.execute(
        f"SELECT {RECORD_COLUMNS} FROM entries WHERE id IN ({marks}) ORDER BY order_no", list(ids)
    )
    return [record_from_row(row) for row in rows]


def browse(con: sqlite3.Connection) -> list[dict[str, Any]]:
    """Preview-sized records for empty-query browsing, in creation order.

    The opening text is enough for labels and A-Z order. ``_chars`` and
    ``_version_count`` keep the list metadata without reading bodies or history.
    """
    rows = con.execute(
        "SELECT id,preview,tags_json,rating,used,last_run,created,updated,"
        "notes,pinned,chars,versions FROM entries ORDER BY order_no"
    )
    return [
        {
            **record_from_row({**dict(zip(row.keys(), row, strict=True)), "body": row["preview"]}),
            "_chars": row["chars"],
            "_version_count": row["versions"],
        }
        for row in rows
    ]
