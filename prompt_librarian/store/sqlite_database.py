"""Authoritative SQLite records and disposable search projections.

Complete normalized records, metadata, tags, terms, and FTS rows change in one
transaction inside the same database.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sqlite3
import threading
import unicodedata

from .models import _coerce_record, index_entry
from .types import SCHEMA_VERSION
from .utils import _as_int, _as_str, log

SIM_MAX_CHARS = 4000
_NON_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)
_INIT_LOCK = threading.RLock()
_INITIALIZED = {}
_ENTRY_COLUMNS = (
    "id,order_no,tags_json,rating,used,pinned,created,updated,last_run,chars,versions,preview"
)
_ENTRY_WRITE_COLUMNS = (
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
_RETIRED_ENTRY_COLUMNS = ("off", "len", "seq")


def normalize(text):
    """Match :func:`prompt_librarian.search.normalize` without importing up-layers."""
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(_NON_WORD_RE.sub(" ", text).split())


def projection(rec, entry):
    """Return the search/list projection for one live record."""
    body = _as_str(rec.get("body", ""))
    tags = list(rec.get("tags") or ())
    body_norm = normalize(body)
    tags_norm = " ".join(filter(None, (normalize(tag) for tag in tags)))
    return {
        **entry,
        "id": _as_str(rec.get("id")),
        "body": body,
        "body_norm": body_norm,
        "tags_norm": tags_norm,
        "sim_norm": body_norm[:SIM_MAX_CHARS],
        "notes": _as_str(rec.get("notes", "")),
    }


def _within_edit_1(a, b):
    la, lb = len(a), len(b)
    if la > lb:
        a, b, la, lb = b, a, lb, la
    if lb - la > 1:
        return False
    if a == b:
        return True
    if la == lb:
        return sum(x != y for x, y in zip(a, b, strict=False)) == 1
    i = j = 0
    skipped = False
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
        elif skipped:
            return False
        else:
            skipped = True
            j += 1
    return True


class SQLiteDatabase:
    """Connection-per-operation facade over the library database."""

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.fts5 = False
        self._retired_entry_columns = ()

    def _connect(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        con = sqlite3.connect(self.path, timeout=10.0)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA foreign_keys=ON")
        con.execute("PRAGMA busy_timeout=10000")
        con.execute("PRAGMA synchronous=NORMAL")
        return con

    @contextlib.contextmanager
    def _connection(self):
        """A committing connection that is always closed after one operation."""
        con = self._connect()
        try:
            with con:
                yield con
        finally:
            con.close()

    def initialize(self):
        """Create the library schema. Returns whether FTS5 is available."""
        # Schema DDL and switching journal mode are lock-upgrading operations.
        # Running them before every point read/write can race a perfectly valid
        # transaction from another store instance. Cache the initialized file
        # identity and keep ordinary connections on the data path only.
        with _INIT_LOCK:
            try:
                stat = os.stat(self.path)
                identity = (stat.st_dev, stat.st_ino)
            except OSError:
                identity = None
            cached = _INITIALIZED.get(self.path)
            if identity is not None and cached and cached[0] == identity:
                self.fts5 = cached[1]
                self._retired_entry_columns = cached[2]
                return self.fts5

            with self._connection() as con:
                # WAL lets search readers proceed during the one writer.
                if con.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
                    con.execute("PRAGMA journal_mode=WAL")
                con.executescript(
                    """
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
                CREATE INDEX IF NOT EXISTS entries_used
                    ON entries(used DESC, last_run DESC, id);
                CREATE INDEX IF NOT EXISTS entries_az ON entries(body_norm, id);
                CREATE TABLE IF NOT EXISTS tags (
                    prompt_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                    tag TEXT NOT NULL,
                    PRIMARY KEY(prompt_id, tag)
                );
                CREATE INDEX IF NOT EXISTS tags_lookup ON tags(tag, prompt_id);
                CREATE TABLE IF NOT EXISTS terms (
                    prompt_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                    term TEXT NOT NULL,
                    in_body INTEGER NOT NULL,
                    in_tag INTEGER NOT NULL,
                    in_head INTEGER NOT NULL,
                    in_sim INTEGER NOT NULL,
                    PRIMARY KEY(prompt_id, term)
                );
                CREATE INDEX IF NOT EXISTS terms_lookup ON terms(term, prompt_id);
                CREATE TABLE IF NOT EXISTS metadata (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    payload TEXT NOT NULL
                );
                """
                )
                columns = {row[1] for row in con.execute("PRAGMA table_info(entries)")}
                # The first authoritative SQLite schema shared its entries table
                # with the retired JSONL index.  Its byte-location columns have
                # no default, so omitting them makes even an UPSERT fail its
                # preliminary NOT NULL checks.  Preserve that database in place:
                # old rows keep their offsets and new rows receive inert zeros.
                self._retired_entry_columns = tuple(
                    column for column in _RETIRED_ENTRY_COLUMNS if column in columns
                )
                try:
                    con.execute(
                        "CREATE VIRTUAL TABLE IF NOT EXISTS prompt_fts "
                        "USING fts5(id UNINDEXED, body, tags, "
                        "tokenize='unicode61 remove_diacritics 2 tokenchars ''_''')"
                    )
                except sqlite3.OperationalError as exc:
                    log.warning("[prompt-librarian] SQLite FTS5 unavailable: %s", exc)
                    self.fts5 = False
                else:
                    self.fts5 = True
                con.execute(
                    "INSERT OR IGNORE INTO state(key,value) VALUES('library_schema',?)",
                    (str(SCHEMA_VERSION),),
                )
            stat = os.stat(self.path)
            _INITIALIZED[self.path] = (
                (stat.st_dev, stat.st_ino),
                self.fts5,
                self._retired_entry_columns,
            )
        return self.fts5

    @staticmethod
    def _set_state(con, key, value):
        con.execute(
            "INSERT INTO state(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )

    @staticmethod
    def _state(con):
        return {row["key"]: row["value"] for row in con.execute("SELECT key,value FROM state")}

    @staticmethod
    def _entry_from_row(row):
        try:
            tags = json.loads(row["tags_json"])
        except (TypeError, ValueError):
            tags = []
        return {
            "tags": tags,
            "rating": row["rating"],
            "used": row["used"],
            "pinned": bool(row["pinned"]),
            "created": row["created"],
            "updated": row["updated"],
            "last_run": row["last_run"],
            "chars": row["chars"],
            "versions": row["versions"],
            "preview": row["preview"],
        }

    def _write_meta(self, con, meta):
        con.execute(
            "INSERT INTO metadata(singleton,payload) VALUES(1,?) "
            "ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload",
            (json.dumps(meta, ensure_ascii=False, separators=(",", ":")),),
        )

    def _put(self, con, rec, entry, order_no):
        p = projection(rec, entry)
        record_json = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
        values = (
            p["id"],
            order_no,
            json.dumps(p["tags"], ensure_ascii=False, separators=(",", ":")),
            p["rating"],
            p["used"],
            int(p["pinned"]),
            p["created"],
            p["updated"],
            p["last_run"],
            p["chars"],
            p["versions"],
            p["preview"],
            p["body"],
            p["body_norm"],
            p["tags_norm"],
            p["sim_norm"],
            p["notes"],
            record_json,
        )
        columns = _ENTRY_WRITE_COLUMNS
        if self._retired_entry_columns:
            columns = (
                columns[0],
                *self._retired_entry_columns,
                *columns[1:],
            )
            values = (values[0], *(0 for _ in self._retired_entry_columns), *values[1:])
        column_sql = ",".join(columns)
        value_sql = ",".join("?" for _column in columns)
        update_sql = ",".join(
            f"{column}=excluded.{column}" for column in _ENTRY_WRITE_COLUMNS if column != "id"
        )
        con.execute(
            f"INSERT INTO entries({column_sql}) VALUES({value_sql}) "
            f"ON CONFLICT(id) DO UPDATE SET {update_sql}",
            values,
        )
        con.execute("DELETE FROM tags WHERE prompt_id=?", (p["id"],))
        con.executemany(
            "INSERT INTO tags(prompt_id,tag) VALUES(?,?)",
            [(p["id"], tag) for tag in p["tags"]],
        )
        con.execute("DELETE FROM terms WHERE prompt_id=?", (p["id"],))
        body_tokens = p["body_norm"].split()
        tag_tokens = p["tags_norm"].split()
        head = set(body_tokens[:12])
        body_set, tag_set = set(body_tokens), set(tag_tokens)
        sim_set = set(p["sim_norm"].split())
        con.executemany(
            "INSERT INTO terms(prompt_id,term,in_body,in_tag,in_head,in_sim) VALUES(?,?,?,?,?,?)",
            [
                (
                    p["id"],
                    term,
                    int(term in body_set),
                    int(term in tag_set),
                    int(term in head),
                    int(term in sim_set),
                )
                for term in sorted(body_set | tag_set)
            ],
        )
        if self.fts5:
            con.execute("DELETE FROM prompt_fts WHERE id=?", (p["id"],))
            con.execute(
                "INSERT INTO prompt_fts(id,body,tags) VALUES(?,?,?)",
                (p["id"], p["body_norm"], p["tags_norm"]),
            )

    def _delete(self, con, pid):
        if self.fts5:
            con.execute("DELETE FROM prompt_fts WHERE id=?", (pid,))
        con.execute("DELETE FROM entries WHERE id=?", (pid,))

    def search_records(self):
        """Current-body projections for search and duplicate detection."""
        with self._connection() as con:
            rows = con.execute(
                "SELECT id,body,tags_json,rating,used,last_run,created,updated,notes,pinned "
                "FROM entries ORDER BY order_no"
            )
            out = []
            for row in rows:
                out.append(
                    {
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
                )
            return out

    def browse_records(self):
        """Preview-sized projections for empty-query browsing.

        Opening text is sufficient for labels and A-Z ordering. The private
        counters preserve full-record list metadata without reading the body or
        serialized version history.
        """
        with self._connection() as con:
            rows = con.execute(
                "SELECT id,preview,tags_json,rating,used,last_run,created,updated,"
                "notes,pinned,chars,versions FROM entries ORDER BY order_no"
            )
            return [
                {
                    "id": row["id"],
                    "body": row["preview"],
                    "tags": json.loads(row["tags_json"]),
                    "rating": row["rating"],
                    "used": row["used"],
                    "last_run": row["last_run"],
                    "created": row["created"],
                    "updated": row["updated"],
                    "notes": row["notes"],
                    "pinned": bool(row["pinned"]),
                    "versions": [],
                    "_chars": row["chars"],
                    "_version_count": row["versions"],
                }
                for row in rows
            ]

    @staticmethod
    def _record_from_row(row):
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

    def candidate_records(self, tokens, mode="all"):  # noqa: C901
        """Only records in exact/prefix candidate postings for ``tokens``.

        When the exact/prefix path misses, include records from the same capped
        infix/edit-1 vocabulary fallback used by the in-memory search.  The
        scorer still runs in :mod:`search`, so ordering and filters stay one
        implementation rather than drifting into SQL-specific behavior.
        """
        tokens = [normalize(token) for token in tokens if normalize(token)]
        if not tokens:
            return self.search_records()
        with self._connection() as con:
            if self.fts5:
                joiner = " AND " if mode == "all" else " OR "
                expression = joiner.join(f'"{token}"*' for token in tokens)
                ids = {
                    row[0]
                    for row in con.execute(
                        "SELECT id FROM prompt_fts WHERE prompt_fts MATCH ?",
                        (expression,),
                    )
                }
            else:
                per_token = []
                for token in tokens:
                    terms = [
                        row[0]
                        for row in con.execute(
                            "SELECT DISTINCT term FROM terms WHERE term LIKE ? "
                            "ORDER BY term LIMIT 200",
                            (token + "%",),
                        )
                    ]
                    ids = set()
                    if terms:
                        marks = ",".join("?" for _ in terms)
                        ids = {
                            row[0]
                            for row in con.execute(
                                f"SELECT DISTINCT prompt_id FROM terms WHERE term IN ({marks})",
                                terms,
                            )
                        }
                    per_token.append(ids)
                if mode == "all":
                    ids = set(per_token[0])
                    for found in per_token[1:]:
                        ids &= found
                else:
                    ids = set().union(*per_token)

            if not ids:
                vocab = [
                    row[0] for row in con.execute("SELECT DISTINCT term FROM terms ORDER BY term")
                ]
                fallback_terms = []
                for token in tokens:
                    for term in vocab:
                        if token in term or (len(token) >= 4 and _within_edit_1(token, term)):
                            fallback_terms.append(term)
                            if len(fallback_terms) >= 200:
                                break
                    if len(fallback_terms) >= 200:
                        break
                if fallback_terms:
                    marks = ",".join("?" for _ in fallback_terms)
                    ids = {
                        row[0]
                        for row in con.execute(
                            f"SELECT DISTINCT prompt_id FROM terms WHERE term IN ({marks})",
                            fallback_terms,
                        )
                    }
            if not ids:
                return []
            marks = ",".join("?" for _ in ids)
            rows = con.execute(
                "SELECT id,body,tags_json,rating,used,last_run,created,updated,notes,pinned "
                f"FROM entries WHERE id IN ({marks}) ORDER BY order_no",
                list(ids),
            )
            return [self._record_from_row(row) for row in rows]

    def record(self, pid):
        with self._connection() as con:
            row = con.execute(
                "SELECT id,body,tags_json,rating,used,last_run,created,updated,notes,pinned "
                "FROM entries WHERE id=?",
                (pid,),
            ).fetchone()
        return self._record_from_row(row) if row else None

    def full_records(self, ids):
        """Return complete records for ``ids`` in caller order.

        Queries are chunked below SQLite's conservative variable limit.
        """
        wanted = list(dict.fromkeys(_as_str(pid) for pid in ids if _as_str(pid)))
        if not wanted:
            return []
        found = {}
        with self._connection() as con:
            for start in range(0, len(wanted), 500):
                chunk = wanted[start : start + 500]
                marks = ",".join("?" for _ in chunk)
                for row in con.execute(
                    f"SELECT id,record_json FROM entries WHERE id IN ({marks})", chunk
                ):
                    try:
                        raw = json.loads(row["record_json"])
                    except (TypeError, ValueError):
                        continue
                    rec = _coerce_record(raw)
                    if rec is not None and rec.get("id") == row["id"]:
                        found[row["id"]] = rec
        return [found[pid] for pid in wanted if pid in found]

    def load_authoritative(self):
        """Load lightweight state from an authoritative SQLite library."""
        self.initialize()
        with self._connection() as con:
            quick = con.execute("PRAGMA quick_check").fetchone()
            if not quick or quick[0] != "ok":
                raise sqlite3.DatabaseError("SQLite quick_check failed")
            state = self._state(con)
            rows = list(con.execute(f"SELECT {_ENTRY_COLUMNS} FROM entries ORDER BY order_no"))
            meta_row = con.execute("SELECT payload FROM metadata WHERE singleton=1").fetchone()
            try:
                meta = json.loads(meta_row[0]) if meta_row else None
            except (TypeError, ValueError) as exc:
                raise sqlite3.DatabaseError("invalid library metadata") from exc
        entries = {row["id"]: self._entry_from_row(row) for row in rows}
        return {
            "entries": entries,
            "order": [row["id"] for row in rows],
            "meta": meta,
            "revision": _as_int(state.get("revision"), 0),
        }

    def authoritative_revision(self):
        """Read the cross-process revision without loading prompt rows."""
        if not os.path.exists(self.path):
            return 0
        with self._connection() as con:
            row = con.execute("SELECT value FROM state WHERE key='revision'").fetchone()
        return _as_int(row[0], 0) if row else 0

    def apply_authoritative(self, items, meta=None):
        """Atomically apply prompt puts/deletes and optional envelope metadata."""
        self.initialize()
        with self._connection() as con:
            con.execute("BEGIN IMMEDIATE")
            state = self._state(con)
            previous_revision = _as_int(state.get("revision"), 0)
            revision = previous_revision + 1
            for op, payload in items:
                if op == "del":
                    self._delete(con, _as_str(payload))
                    continue
                if op != "put":
                    continue
                rec = payload
                pid = _as_str(rec.get("id"))
                resident = con.execute(
                    "SELECT order_no FROM entries WHERE id=?",
                    (pid,),
                ).fetchone()
                if resident is None:
                    resident = con.execute(
                        "SELECT COALESCE(MAX(order_no),-1)+1 FROM entries"
                    ).fetchone()
                entry = index_entry(rec)
                self._put(con, rec, entry, resident[0])
            if meta is not None:
                self._write_meta(con, meta)
            self._set_state(con, "revision", revision)
            self._set_state(con, "library_schema", SCHEMA_VERSION)
        return revision, previous_revision

    def replace_authoritative(self, records, meta):
        """Atomically replace all authoritative library state."""
        self.initialize()
        with self._connection() as con:
            con.execute("BEGIN IMMEDIATE")
            state = self._state(con)
            revision = _as_int(state.get("revision"), 0) + 1
            con.execute("DELETE FROM tags")
            con.execute("DELETE FROM terms")
            con.execute("DELETE FROM entries")
            if self.fts5:
                con.execute("DELETE FROM prompt_fts")
            for order_no, rec in enumerate(records):
                entry = index_entry(rec)
                self._put(con, rec, entry, order_no)
            self._write_meta(con, meta)
            self._set_state(con, "revision", revision)
            self._set_state(con, "library_schema", SCHEMA_VERSION)
        return revision

    def optimize_authoritative(self):
        """Run SQLite's planner maintenance and VACUUM; return byte counts."""
        before = os.path.getsize(self.path) if os.path.exists(self.path) else 0
        self.initialize()
        con = self._connect()
        try:
            con.execute("PRAGMA optimize")
            con.commit()
            con.execute("VACUUM")
        finally:
            con.close()
        after = os.path.getsize(self.path) if os.path.exists(self.path) else 0
        return before, after

    def authoritative_health(self):
        """Database health and free-page information for the storage panel."""
        if not os.path.exists(self.path):
            return {"state": "new", "fts5": False, "bytes": 0, "reclaimable_bytes": 0}
        try:
            self.initialize()
            with self._connection() as con:
                quick = con.execute("PRAGMA quick_check").fetchone()
                page_size = con.execute("PRAGMA page_size").fetchone()[0]
                free_pages = con.execute("PRAGMA freelist_count").fetchone()[0]
            return {
                "state": "ready" if quick and quick[0] == "ok" else "error",
                "fts5": self.fts5,
                "bytes": os.path.getsize(self.path),
                "reclaimable_bytes": int(page_size) * int(free_pages),
            }
        except (OSError, sqlite3.DatabaseError):
            return {
                "state": "error",
                "fts5": False,
                "bytes": os.path.getsize(self.path),
                "reclaimable_bytes": 0,
            }

    def corpus_stats(self):
        with self._connection() as con:
            row = con.execute("SELECT COUNT(*), COALESCE(MAX(used),0) FROM entries").fetchone()
            updated = [
                item[0] for item in con.execute("SELECT updated FROM entries ORDER BY updated")
            ]
        return {"count": row[0], "max_used": row[1], "updated": updated}

    def term_df(self, token):
        with self._connection() as con:
            row = con.execute(
                "SELECT COUNT(*) FROM terms WHERE term=?", (normalize(token),)
            ).fetchone()
        return row[0] if row else 0

    def dupe_candidate_records(self, text, threshold=0.9, exclude=()):
        """Disk-backed equivalent of ``DupeIndex.candidates`` plus projections."""
        probe = normalize(text)[:SIM_MAX_CHARS]
        toks = set(probe.split())
        if not probe:
            return []
        excluded = {str(pid) for pid in exclude if pid}
        with self._connection() as con:
            total = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
            cap = max(50, 0.15 * total)
            dfs = []
            for token in toks:
                df = con.execute(
                    "SELECT COUNT(*) FROM terms WHERE term=? AND in_sim=1", (token,)
                ).fetchone()[0]
                if df <= cap:
                    dfs.append((df, token))
            ids = set()
            rare = [token for _df, token in sorted(dfs)[:8]]
            if rare:
                marks = ",".join("?" for _ in rare)
                ids.update(
                    row[0]
                    for row in con.execute(
                        f"SELECT DISTINCT prompt_id FROM terms "
                        f"WHERE in_sim=1 AND term IN ({marks})",
                        rare,
                    )
                )
            if len(toks) < 4 or not ids:
                low, high = max(0, len(toks) - 1), len(toks) + 1
                ids.update(
                    row[0]
                    for row in con.execute(
                        "SELECT prompt_id FROM terms WHERE in_sim=1 GROUP BY prompt_id "
                        "HAVING COUNT(*) BETWEEN ? AND ?",
                        (low, high),
                    )
                )
            ids -= excluded
            if not ids:
                return []
            marks = ",".join("?" for _ in ids)
            rows = list(
                con.execute(
                    "SELECT id,body,tags_json,rating,used,last_run,created,updated,notes,"
                    f"pinned,sim_norm FROM entries WHERE id IN ({marks})",
                    list(ids),
                )
            )
        out = []
        la, na = len(toks), len(probe)
        for row in rows:
            other = row["sim_norm"] or ""
            nb = len(other)
            if not (2 * min(na, nb) >= float(threshold) * (na + nb)):
                continue
            other_toks = set(other.split())
            if la and other_toks and len(toks & other_toks) < 0.5 * min(la, len(other_toks)):
                continue
            out.append(self._record_from_row(row))
        return out
