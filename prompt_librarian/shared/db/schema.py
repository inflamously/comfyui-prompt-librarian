"""The library's own tables: ``state``, ``entries``, ``tags`` and ``metadata``.

Features that keep derived tables (the corpus, autocomplete) create their own;
this module owns only the records and the library envelope.
"""

import json
import sqlite3

from ..coerce import as_int

SCHEMA_VERSION = 1

#: Byte-location columns left by the JSONL-era implementation. Old databases
#: still require them (NOT NULL, no default), so writers supply inert zeros.
RETIRED_ENTRY_COLUMNS = ("off", "len", "seq")

_DDL = """
CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    order_no INTEGER NOT NULL,
    tags_json TEXT NOT NULL,
    rating INTEGER NOT NULL,
    used INTEGER NOT NULL,
    pinned INTEGER NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    last_run TEXT NOT NULL,
    chars INTEGER NOT NULL,
    versions INTEGER NOT NULL,
    preview TEXT NOT NULL,
    body TEXT NOT NULL,
    body_norm TEXT NOT NULL,
    tags_norm TEXT NOT NULL,
    sim_norm TEXT NOT NULL,
    notes TEXT NOT NULL,
    record_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS entries_recent ON entries(updated DESC, id);
CREATE INDEX IF NOT EXISTS entries_used ON entries(used DESC, last_run DESC, id);
CREATE INDEX IF NOT EXISTS entries_az ON entries(body_norm, id);
CREATE TABLE IF NOT EXISTS tags (
    prompt_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY(prompt_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_lookup ON tags(tag, prompt_id);
CREATE TABLE IF NOT EXISTS metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    payload TEXT NOT NULL
);
"""


def use_wal(con: sqlite3.Connection) -> None:
    """Switch to WAL, so readers proceed during the one writer. Outside a transaction."""
    if con.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
        con.execute("PRAGMA journal_mode=WAL")


def newer_schema(con: sqlite3.Connection) -> bool:
    """True when the library declares a schema newer than this build understands.

    Raises:
        sqlite3.DatabaseError: The metadata row is not valid JSON.
    """
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='metadata'").fetchone():
        return False
    row = con.execute("SELECT payload FROM metadata WHERE singleton=1").fetchone()
    try:
        return bool(row and as_int(json.loads(row[0]).get("schema"), 0) > SCHEMA_VERSION)
    except (TypeError, ValueError, AttributeError) as exc:
        raise sqlite3.DatabaseError("invalid library metadata") from exc


def create(con: sqlite3.Connection) -> tuple[str, ...]:
    """Create the library tables if missing; returns the retired columns present.

    ``executescript`` would commit the caller's transaction, so statements run
    one by one inside it.
    """
    for statement in filter(None, (part.strip() for part in _DDL.split(";"))):
        con.execute(statement)
    con.execute(
        "INSERT OR IGNORE INTO state(key,value) VALUES('library_schema',?)", (str(SCHEMA_VERSION),)
    )
    columns = {row[1] for row in con.execute("PRAGMA table_info(entries)")}
    return tuple(column for column in RETIRED_ENTRY_COLUMNS if column in columns)


def read_meta(con: sqlite3.Connection) -> dict | None:
    """The library envelope (settings, snippets, ignored pairs…), or ``None`` if unset.

    Raises:
        sqlite3.DatabaseError: The metadata row is not valid JSON.
    """
    row = con.execute("SELECT payload FROM metadata WHERE singleton=1").fetchone()
    if not row:
        return None
    try:
        meta = json.loads(row[0])
    except (TypeError, ValueError) as exc:
        raise sqlite3.DatabaseError("invalid library metadata") from exc
    return meta if isinstance(meta, dict) else None


def write_meta(con: sqlite3.Connection, meta: dict) -> None:
    """Replace the library envelope, inside the caller's write transaction."""
    con.execute(
        "INSERT INTO metadata(singleton,payload) VALUES(1,?) "
        "ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload",
        (json.dumps(meta, ensure_ascii=False, separators=(",", ":")),),
    )
