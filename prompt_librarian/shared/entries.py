"""Rows of the ``entries`` and ``tags`` tables: the prompt records themselves.

Prompt editing, imports and legacy migration all write records through here.

The complete record is ``record_json``; the other columns are the list/sort
summary (:func:`~prompt_librarian.shared.records.index_entry`) and the corpus
projection. Every write also runs the library's derived-table writers.
"""

import copy
import json
import sqlite3
from typing import Any

from . import corpus
from .library import Write
from .records import Record, coerce_record, index_entry

_WRITE_COLUMNS = (
    "id",
    "order_no",
    "tags_json",
    "rating",
    "used",
    "pinned",
    "created",
    "updated",
    "last_run",
    "chars",
    "versions",
    "preview",
    "body",
    "body_norm",
    "tags_norm",
    "sim_norm",
    "notes",
    "record_json",
)
_CHUNK = 500  # below SQLite's conservative host-parameter limit


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load(row: sqlite3.Row | None) -> Record | None:
    if row is None:
        return None
    try:
        rec = coerce_record(json.loads(row[1]))
    except (TypeError, ValueError):
        return None
    return rec if rec is not None and rec.get("id") == row[0] else None


def get(con: sqlite3.Connection, pid: str) -> Record | None:
    """One complete record, or ``None``."""
    return _load(con.execute("SELECT id,record_json FROM entries WHERE id=?", (pid,)).fetchone())


def get_many(con: sqlite3.Connection, ids: list[str]) -> list[Record]:
    """Complete records for ``ids`` that exist, in the order asked for."""
    wanted = list(dict.fromkeys(str(pid) for pid in ids if pid))
    found: dict[str, Record] = {}
    for start in range(0, len(wanted), _CHUNK):
        chunk = wanted[start : start + _CHUNK]
        marks = ",".join("?" for _ in chunk)
        for row in con.execute(f"SELECT id,record_json FROM entries WHERE id IN ({marks})", chunk):
            rec = _load(row)
            if rec is not None:
                found[rec["id"]] = rec
    return [found[pid] for pid in wanted if pid in found]


def ids(con: sqlite3.Connection) -> list[str]:
    """Every record id, in creation order."""
    return [row[0] for row in con.execute("SELECT id FROM entries ORDER BY order_no")]


def count(con: sqlite3.Connection) -> int:
    """Number of records."""
    return con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]


def tag_counts(con: sqlite3.Connection) -> list[tuple[str, int]]:
    """Every tag with its record count, most used first."""
    return con.execute(
        "SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag"
    ).fetchall()


def put(work: Write, rec: Record) -> None:
    """Insert or replace one record, keeping its creation order and derived rows."""
    con, pid = work.con, rec["id"]
    resident = con.execute("SELECT order_no,body FROM entries WHERE id=?", (pid,)).fetchone()
    if resident is None:
        order_no = con.execute("SELECT COALESCE(MAX(order_no),-1)+1 FROM entries").fetchone()[0]
        previous_body = None
    else:
        order_no, previous_body = resident[0], resident[1]
    p = corpus.projection(rec, index_entry(rec))
    _upsert_entry(con, p, order_no, _json(rec), work.library.retired_columns)
    con.execute("DELETE FROM tags WHERE prompt_id=?", (pid,))
    con.executemany(
        "INSERT INTO tags(prompt_id,tag) VALUES(?,?)", [(pid, tag) for tag in p["tags"]]
    )
    work.library.project(con, pid, p, previous_body)
    work.touched(pid, copy.deepcopy(rec), previous_body != p["body"])


def _upsert_entry(
    con: sqlite3.Connection,
    p: dict[str, Any],
    order_no: int,
    record_json: str,
    retired: tuple[str, ...],
) -> None:
    values = [
        p["id"], order_no, _json(p["tags"]), p["rating"], p["used"], int(p["pinned"]),
        p["created"], p["updated"], p["last_run"], p["chars"], p["versions"], p["preview"],
        p["body"], p["body_norm"], p["tags_norm"], p["sim_norm"], p["notes"], record_json,
    ]  # fmt: skip
    # Old libraries still require the retired byte-location columns: inert zeros.
    columns = (_WRITE_COLUMNS[0], *retired, *_WRITE_COLUMNS[1:])
    values[1:1] = [0] * len(retired)
    update = ",".join(f"{column}=excluded.{column}" for column in _WRITE_COLUMNS[1:])
    con.execute(
        f"INSERT INTO entries({','.join(columns)}) VALUES({','.join('?' * len(columns))}) "
        f"ON CONFLICT(id) DO UPDATE SET {update}",
        values,
    )


def remove(work: Write, pid: str) -> bool:
    """Delete one record and its derived rows. Returns whether it existed."""
    con = work.con
    row = con.execute("SELECT body FROM entries WHERE id=?", (pid,)).fetchone()
    if row is None:
        return False
    work.library.project(con, pid, None, row[0])
    con.execute("DELETE FROM entries WHERE id=?", (pid,))
    work.touched(pid, None, True)
    return True


def clear(work: Write) -> None:
    """Delete every record and derived row, before a full replacement."""
    corpus.clear(work.con, work.library.fts5)
    work.con.execute("DELETE FROM tags")
    work.con.execute("DELETE FROM entries")
