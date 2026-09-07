"""SQLite is authoritative. Commit records, metadata, tags, postings, and FTS5
projections in the same transaction; JSON/JSONL serve migration and export.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import sqlite3
import threading

from .legacy import read_legacy, same_record
from .models import (
    OP_DEL,
    OP_PUT,
    _coerce,
    clean_pairs,
    clean_settings,
    clean_snippets,
    index_entry,
)
from .operations import LibraryOperations
from .sqlite_database import SQLiteDatabase
from .types import SCHEMA_VERSION, NotFoundError, ReadOnlyError, StoreWriteError
from .utils import (
    _as_int,
    _as_str,
    database_path,
    log,
    now_iso,
)

VACUUM_MIN_BYTES = 8 * 1024 * 1024


class LibrarianStore(LibraryOperations):
    """The prompt library as one authoritative SQLite database."""

    def __init__(self, path=None, migrate_from=None):
        self._path = path
        self._migrate_from = migrate_from
        self._lock = threading.RLock()
        self._entries = {}
        self._order = []
        self._meta = None
        self._meta_dirty = False
        self._size = -1
        self._rev = 0
        self._db_revision = -1
        self._corrupt = False
        self._readonly = False
        self._listeners = []
        self._index = SQLiteDatabase(self.store_path())
        self._search_cache_rev = -1
        self._corpus_cache = None
        self._df_cache = {}


    def store_path(self):
        return self._path if self._path else database_path()

    def _neighbor(self, suffix):
        base, _extension = os.path.splitext(os.path.basename(self.store_path()))
        return os.path.join(self.store_dir(), base + suffix)

    def legacy_sources(self):
        """Existing JSONL/JSON migration files, without a directory scan."""
        if self._migrate_from is False:
            return []
        if isinstance(self._migrate_from, (str, os.PathLike)):
            source = os.fspath(self._migrate_from)
            return [source] if os.path.isfile(source) else []
        candidates = (
            self._neighbor(".jsonl"),
            self._neighbor(".json"),
        )
        return [path for path in candidates if os.path.isfile(path)]

    @staticmethod
    def _migration_fingerprint(source):
        stat = os.stat(source)
        return hashlib.sha256(
            f"{os.path.abspath(source)}:{stat.st_size}:{stat.st_mtime_ns}".encode()
        ).hexdigest()


    @staticmethod
    def _default_meta():
        env = _coerce({})
        return {
            "schema": env["schema"],
            "updated": env["updated"],
            "settings": env["settings"],
            "snippets": env["snippets"],
            "ignored": env["ignored"],
        }

    def ensure_loaded(self, force=False):
        """Refresh lightweight rows only when another connection committed."""
        with self._lock:
            path = self.store_path()
            if not os.path.exists(path):
                if force or self._meta is None or self._db_revision != 0:
                    self._entries = {}
                    self._order = []
                    self._meta = self._default_meta()
                    self._meta_dirty = False
                    self._db_revision = 0
                    self._size = 0
                    self._readonly = False
                    self._corrupt = False
                    self._rev += 1
                return
            try:
                revision = self._index.authoritative_revision()
                if not force and self._meta is not None and revision == self._db_revision:
                    return
                raw = self._index.load_authoritative()
            except (OSError, sqlite3.DatabaseError) as exc:
                self._corrupt = True
                if self._meta is None:
                    self._entries = {}
                    self._order = []
                    self._meta = self._default_meta()
                    self._rev += 1
                log.error("[prompt-librarian] cannot read SQLite library %s: %s", path, exc)
                return

            self._entries = raw["entries"]
            self._order = raw["order"]
            self._meta = raw.get("meta") or self._default_meta()
            self._meta_dirty = False
            self._meta["settings"] = clean_settings(self._meta.get("settings"))
            self._meta["snippets"] = clean_snippets(self._meta.get("snippets"))
            self._meta["ignored"] = clean_pairs(self._meta.get("ignored"))
            self._db_revision = raw["revision"]
            try:
                stat = os.stat(path)
                self._size = stat.st_size
            except OSError:
                self._size = 0
            self._readonly = _as_int(self._meta.get("schema"), SCHEMA_VERSION) > SCHEMA_VERSION
            self._corrupt = False
            self._rev += 1

    def is_corrupt(self):
        self.ensure_loaded()
        with self._lock:
            return self._corrupt

    def _begin_write(self):
        self.ensure_loaded()
        if self._corrupt:
            raise StoreWriteError(
                f"the SQLite library at {self.store_path()} is unreadable; "
                "restore or move it before writing"
            )
        if self._readonly:
            raise ReadOnlyError(
                f"the library declares schema {self._meta.get('schema')}, "
                f"this build understands {SCHEMA_VERSION}"
            )


    @staticmethod
    def _validate_items(items):
        """Serialize puts before a transaction so encoding cannot half-write."""
        try:
            for op, payload in items:
                if op == OP_PUT:
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise StoreWriteError(f"record could not be serialized: {exc}") from exc

    def _metadata_for_delete(self, deleted):
        kept_pairs = [
            pair
            for pair in self._meta["ignored"]
            if pair[0] not in deleted and pair[1] not in deleted
        ]
        if kept_pairs == self._meta["ignored"]:
            return self._meta if self._meta_dirty else None
        meta = copy.deepcopy(self._meta)
        meta["ignored"] = kept_pairs
        return meta

    def _patch_entries(self, sql_items, deleted, revision):
        new_ids = []
        for op, payload in sql_items:
            if op == OP_DEL:
                self._entries.pop(_as_str(payload), None)
                continue
            pid = payload["id"]
            if pid not in self._entries:
                self._order.append(pid)
                new_ids.append(pid)
            self._entries[pid] = index_entry(payload)
        if deleted:
            self._order = [pid for pid in self._order if pid not in deleted]
        return new_ids

    def _commit_items(self, items):
        """Commit a small put/delete batch and all its projections atomically."""
        if not items:
            return []
        self._validate_items(items)

        deleted = {_as_str(payload) for op, payload in items if op == OP_DEL}
        sql_items = [(op, payload) for op, payload in items if op in (OP_PUT, OP_DEL)]
        meta = self._metadata_for_delete(deleted)
        try:
            revision, previous_revision = self._index.apply_authoritative(sql_items, meta)
        except (OSError, sqlite3.DatabaseError, TypeError, ValueError) as exc:
            raise StoreWriteError(f"cannot write {self.store_path()}: {exc}") from exc
        if meta is not None:
            self._meta = meta
        self._meta_dirty = False

        if previous_revision != self._db_revision:
            # Another writer committed after our preamble. Refresh rows so the new revision
            # does not hide records committed by that connection.
            self._db_revision = revision
            self.ensure_loaded(force=True)
            return []

        new_ids = self._patch_entries(sql_items, deleted, revision)
        self._db_revision = revision
        try:
            stat = os.stat(self.store_path())
            self._size = stat.st_size
        except OSError:
            pass
        self._rev += 1
        return [(pid, 0, 0) for pid in new_ids]

    def _save_meta(self):
        self._meta["updated"] = now_iso()
        try:
            revision, previous_revision = self._index.apply_authoritative([], self._meta)
        except (OSError, sqlite3.DatabaseError, TypeError, ValueError) as exc:
            raise StoreWriteError(f"cannot write {self.store_path()}: {exc}") from exc
        if previous_revision != self._db_revision:
            self._db_revision = revision
            self.ensure_loaded(force=True)
            return
        self._db_revision = revision
        self._meta_dirty = False
        self._rev += 1

    def _read_records(self, ids):
        try:
            return self._index.full_records(ids)
        except (OSError, sqlite3.DatabaseError) as exc:
            self._corrupt = True
            raise StoreWriteError(f"cannot read {self.store_path()}: {exc}") from exc

    def _replace_library(self, records):
        records = list(records)
        try:
            for rec in records:
                json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
            revision = self._index.replace_authoritative(records, self._meta)
        except (OSError, sqlite3.DatabaseError, TypeError, ValueError) as exc:
            raise StoreWriteError(f"cannot replace {self.store_path()}: {exc}") from exc
        self._entries = {rec["id"]: index_entry(rec) for rec in records}
        self._order = [rec["id"] for rec in records]
        self._db_revision = revision
        self._meta_dirty = False
        self._corrupt = False
        try:
            stat = os.stat(self.store_path())
            self._size = stat.st_size
        except OSError:
            self._size = 0
        self._rev += 1

    def _ensure_sqlite(self):
        self.ensure_loaded()
        return os.path.exists(self.store_path()) and not self._corrupt

    def list_search_records(self):
        """Preview-sized projections for empty-query browsing."""
        self.ensure_loaded()
        with self._lock:
            if not self._ensure_sqlite():
                return []
            try:
                return self._index.browse_records()
            except (OSError, sqlite3.DatabaseError) as exc:
                self._corrupt = True
                raise StoreWriteError(f"cannot browse {self.store_path()}: {exc}") from exc

    def flush(self):
        """Connections commit and close per operation; retained for callers."""

    close = flush


    def storage_status(self):
        self.ensure_loaded()
        with self._lock:
            health = (
                self._index.authoritative_health()
                if not self._corrupt
                else {
                    "state": "error",
                    "fts5": False,
                    "bytes": max(0, self._size),
                    "reclaimable_bytes": 0,
                }
            )
            reclaimable = health.get("reclaimable_bytes", 0)
            database_bytes = health.get("bytes", max(0, self._size))
            migrations = self._meta.get("migrations") or {}
            sources = [
                source
                for source in self.legacy_sources()
                if self._migration_fingerprint(source) not in migrations
            ]
            legacy_bytes = sum(
                os.path.getsize(source) for source in sources if os.path.isfile(source)
            )
            return {
                "database_bytes": database_bytes,
                "reclaimable_bytes": reclaimable,
                "records": len(self._entries),
                "should_compact": (
                    database_bytes >= VACUUM_MIN_BYTES and reclaimable > database_bytes // 5
                ),
                "index": {
                    "state": health.get("state", "error"),
                    "fts5": bool(health.get("fts5")),
                },
                "legacy": {
                    "available": bool(sources),
                    "bytes": legacy_bytes,
                    "sources": [os.path.basename(source) for source in sources],
                },
            }

    def compact(self):
        """Run SQLite planner maintenance and VACUUM on explicit request."""
        with self._lock:
            self._begin_write()
            try:
                before, after = self._index.optimize_authoritative()
            except (OSError, sqlite3.DatabaseError) as exc:
                raise StoreWriteError(f"cannot optimize {self.store_path()}: {exc}") from exc
            self.ensure_loaded(force=True)
            return {"before": before, "after": after, "records": len(self._entries)}


    def migrate_legacy(self, path=None):  # noqa: C901
        """Merge one legacy JSON/JSONL library; leave the source unchanged."""
        if path is None:
            self.ensure_loaded()
            migrations = self._meta.get("migrations") or {}
            pending = [
                source
                for source in self.legacy_sources()
                if self._migration_fingerprint(source) not in migrations
            ]
            if len(pending) > 1:
                results = [self.migrate_legacy(source) for source in pending]
                return {
                    "imported": sum(result["imported"] for result in results),
                    "skipped": sum(result["skipped"] for result in results),
                    "collisions": sum(result["collisions"] for result in results),
                    "already_migrated": all(result["already_migrated"] for result in results),
                }
            sources = self.legacy_sources()
            source = pending[0] if pending else (sources[0] if sources else None)
        else:
            source = os.fspath(path)
        if not source or not os.path.isfile(source):
            raise NotFoundError(f"no legacy library at {source or self._neighbor('.jsonl')}")
        fingerprint = self._migration_fingerprint(source)
        incoming, unreadable = read_legacy(source)

        with self._lock:
            self._begin_write()
            migrations = dict(self._meta.get("migrations") or {})
            if fingerprint in migrations:
                return {
                    "imported": 0,
                    "skipped": len(incoming["prompts"]) + unreadable,
                    "collisions": 0,
                    "already_migrated": True,
                }
            for name, entry in incoming["snippets"].items():
                self._meta["snippets"].setdefault(name, entry)
            have_pairs = {tuple(pair) for pair in self._meta["ignored"]}
            for pair in incoming["ignored"]:
                if tuple(pair) not in have_pairs:
                    self._meta["ignored"].append(pair)

            imported, skipped, collisions = [], unreadable, 0
            for rec in incoming["prompts"]:
                rec = dict(rec)
                current = self.get(rec["id"])
                if current is not None:
                    if same_record(current, rec):
                        skipped += 1
                        continue
                    collisions += 1
                    original = rec["id"]
                    rec["id"] = hashlib.md5(  # noqa: S324 - deterministic id only
                        f"{fingerprint}:{original}".encode()
                    ).hexdigest()
                    existing = self.get(rec["id"])
                    attempt = 1
                    while existing is not None and not same_record(existing, rec):
                        rec["id"] = hashlib.md5(  # noqa: S324
                            f"{fingerprint}:{original}:{attempt}".encode()
                        ).hexdigest()
                        attempt += 1
                        existing = self.get(rec["id"])
                    if existing is not None:
                        skipped += 1
                        continue
                imported.append(rec)

            migrations[fingerprint] = {
                "source": os.path.basename(source),
                "updated": now_iso(),
            }
            self._meta["migrations"] = migrations
            self._meta_dirty = True
            # Metadata and imported records commit together.
            self._commit_items([(OP_PUT, rec) for rec in imported])
            if not imported:
                self._save_meta()
            self._emit(
                "import",
                [rec["id"] for rec in imported],
                {rec["id"]: copy.deepcopy(rec) for rec in imported},
            )
            return {
                "imported": len(imported),
                "skipped": skipped,
                "collisions": collisions,
                "already_migrated": False,
            }
