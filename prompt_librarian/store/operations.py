"""Library operations backed exclusively by the authoritative SQLite store.

This module contains record-level behavior: validation, CRUD, versions, merges,
taxonomy, snippets, ignored duplicate pairs, and portable JSON envelopes.  The
SQLite class supplies the transaction and query primitives these methods call.
"""

import copy
import os

from .models import (
    OP_DEL,
    OP_PUT,
    _clean_record,
    _coerce,
    _merge_fields,
    _trim_versions,
    clean_settings,
    envelope_from_parts,
)
from .sqlite_database import normalize as index_normalize
from .types import (
    EVENT_CHANGED,
    EVENT_USED,
    MAX_SNIPPET_NAME_CHARS,
    MERGE_VERSIONS_KEPT,
    SCHEMA_VERSION,
    VERSION_CAP,
    ConflictError,
    NotFoundError,
    SameRecordError,
)
from .utils import (
    _as_int,
    _as_str,
    _clamp,
    clean_body,
    clean_tags,
    log,
    new_id,
    now_iso,
    preview_of,
)


class LibraryOperations:
    """High-level library behavior; persistence primitives come from SQLite."""

    def store_dir(self):
        """Directory containing this store's database and wildcard files."""
        return os.path.dirname(os.path.abspath(self.store_path()))

    def wildcards_dir(self):
        """Directory holding ``__wildcard__`` text files for this store."""
        return os.path.join(self.store_dir(), "wildcards")

    def rev(self):
        """Monotonic revision counter, bumped on every load and every save.

        Search and dedupe cache on this value, and every api response echoes it.
        """
        self.ensure_loaded()
        with self._lock:
            return self._rev

    def is_readonly(self):
        """True when the library's ``schema`` is newer than this build; writes refuse."""
        self.ensure_loaded()
        with self._lock:
            return self._readonly

    def on_change(self, callback):
        """Register ``cb(op, ids, records)``; returns a function that unregisters it.

        Called after a *successful* write. ``records`` maps id → the new record
        dict, or ``None`` when that id was deleted, which is exactly what the
        search and dedupe indexes need to patch themselves incrementally instead
        of rebuilding. Listener exceptions are swallowed: a broken index must not
        fail a write that already hit the disk.
        """
        with self._lock:
            self._listeners.append(callback)

        def _unsubscribe():
            with self._lock:
                if callback in self._listeners:
                    self._listeners.remove(callback)

        return _unsubscribe

    def _notify(self, event, payload):
        """Best-effort websocket push. The store never depends on the server."""
        try:
            from server import PromptServer  # imported lazily; absent in tests

            PromptServer.instance.send_sync(event, payload)
        except Exception:
            pass

    def _emit(self, op, ids, records):
        for callback in list(self._listeners):
            try:
                callback(op, list(ids), records)
            except Exception:
                log.debug("[prompt-librarian] on_change listener failed", exc_info=True)
        self._notify(EVENT_CHANGED, {"op": op, "ids": list(ids), "rev": self._rev})

    def get(self, pid):
        """Return one record, or ``None`` when the id is unknown. One seek, one read."""
        self.ensure_loaded()
        with self._lock:
            entry = self._entries.get(pid)
            if entry is None:
                return None
            found = self._read_records([pid])
            return found[0] if found else None

    def get_many(self, ids):
        """Return ``{id: record}`` for the ids that exist (batch node-face fetch)."""
        wanted = list(dict.fromkeys(ids))
        self.ensure_loaded()
        with self._lock:
            return {rec["id"]: rec for rec in self._read_records(wanted)}

    def all(self):
        """Every record, in creation order."""
        self.ensure_loaded()
        with self._lock:
            return self._read_records(self._order)

    list_all = all  # noqa: A003 - search/dedupe store protocol

    def count(self):
        """Number of records, answered from lightweight database state."""
        self.ensure_loaded()
        with self._lock:
            return len(self._entries)

    def ids(self):
        """Every record id, in creation order. From the index."""
        self.ensure_loaded()
        with self._lock:
            return [pid for pid in self._order if pid in self._entries]

    def index_of(self, pid):
        """The list/search metadata for one id, without its full body."""
        self.ensure_loaded()
        with self._lock:
            entry = self._entries.get(pid)
            return dict(entry) if entry is not None else None

    def list_index(self):
        """Every list/search metadata entry in creation order."""
        self.ensure_loaded()
        with self._lock:
            return [dict(self._entries[pid], id=pid) for pid in self._order if pid in self._entries]

    def search_candidate_records(self, tokens, mode="all"):
        """SQLite-backed exact/prefix/fuzzy candidate projections."""
        self.ensure_loaded()
        with self._lock:
            if not self._ensure_sqlite():
                return self._read_records(self._order)
            try:
                return self._index.candidate_records(tokens, mode)
            except Exception:
                return self._read_records(self._order)

    def search_corpus_stats(self):
        self.ensure_loaded()
        with self._lock:
            self._refresh_search_cache()
            if self._corpus_cache is not None:
                return self._corpus_cache
            if self._ensure_sqlite():
                try:
                    self._corpus_cache = self._index.corpus_stats()
                    return self._corpus_cache
                except Exception:
                    pass
            records = self.list_index()
            self._corpus_cache = {
                "count": len(records),
                "max_used": max((entry.get("used", 0) for entry in records), default=0),
                "updated": sorted(entry.get("updated", "") for entry in records),
            }
            return self._corpus_cache

    def search_term_df(self, token):
        self.ensure_loaded()
        with self._lock:
            self._refresh_search_cache()
            wanted = index_normalize(token)
            if not wanted:
                return 0
            if wanted in self._df_cache:
                return self._df_cache[wanted]
            if self._ensure_sqlite():
                try:
                    self._df_cache[wanted] = self._index.term_df(wanted)
                    return self._df_cache[wanted]
                except Exception:
                    pass
            self._df_cache[wanted] = sum(
                wanted
                in {
                    *index_normalize(rec.get("body") or "").split(),
                    *(
                        part
                        for tag in rec.get("tags") or ()
                        for part in index_normalize(tag).split()
                    ),
                }
                for rec in self._read_records(self._order)
            )
            return self._df_cache[wanted]

    def _refresh_search_cache(self):
        if self._search_cache_rev == self._rev:
            return
        self._search_cache_rev = self._rev
        self._corpus_cache = None
        self._df_cache = {}

    def dupe_candidate_records(self, text, threshold=0.9, exclude=()):
        """Similarity candidates from the SQLite token/length projections."""
        self.ensure_loaded()
        with self._lock:
            if self._ensure_sqlite():
                try:
                    return self._index.dupe_candidate_records(text, threshold, exclude)
                except Exception:
                    pass
            return self._read_records(self._order)

    def indexed_record(self, pid):
        """Current-body projection for search/index consumers."""
        self.ensure_loaded()
        with self._lock:
            if self._ensure_sqlite():
                try:
                    return self._index.record(pid)
                except Exception:
                    pass
            return self.get(pid)

    def settings(self):
        """Return a copy of the settings block."""
        self.ensure_loaded()
        with self._lock:
            return dict(self._meta["settings"])

    def set_settings(self, dupe_threshold=None, version_cap=None):
        """Update the persisted settings; returns the new settings block."""
        with self._lock:
            self._begin_write()
            settings = dict(self._meta["settings"])
            if dupe_threshold is not None:
                try:
                    settings["dupe_threshold"] = _clamp(float(dupe_threshold), 0.0, 1.0)
                except (TypeError, ValueError) as exc:
                    raise ValueError("dupe_threshold must be a number in 0..1") from exc
            if version_cap is not None:
                settings["version_cap"] = _clamp(_as_int(version_cap, VERSION_CAP), 1, 1000)
            self._meta["settings"] = clean_settings(settings)
            self._save_meta()
            self._emit("settings", [], {})
            return dict(self._meta["settings"])

    def _version_cap(self):
        return _clamp(
            _as_int(self._meta["settings"].get("version_cap", VERSION_CAP), VERSION_CAP), 1, 1000
        )

    def create(self, body="", tags=None, rating=0, notes="", pinned=False):
        """Create a record and return it in one transaction.

        The body is validated (``BodyTooLargeError``) before anything is written.
        """
        with self._lock:
            self._begin_write()
            stamp = now_iso()
            rec = _clean_record(
                {
                    "id": new_id(),
                    "body": body,
                    "tags": tags or [],
                    "rating": rating,
                    "used": 0,
                    "last_run": "",
                    "created": stamp,
                    "updated": stamp,
                    "notes": notes,
                    "pinned": pinned,
                    "versions": [],
                }
            )
            self._commit_items([(OP_PUT, rec)])
            out = copy.deepcopy(rec)
            self._emit("create", [rec["id"]], {rec["id"]: out})
            return out

    def update(
        self,
        pid,
        body=None,
        tags=None,
        rating=None,
        notes=None,
        pinned=None,
        snapshot=True,
        expect_updated=None,
    ):
        """Update the given fields of a record and return it.

        Only the arguments that are not ``None`` are applied.

        ``expect_updated`` is the optimistic-concurrency check: pass the
        ``updated`` timestamp the caller loaded and a mismatch raises
        :class:`~.types.ConflictError` instead of silently overwriting a change
        made in another tab or process.

        Snapshot rule: the *pre-edit* body is pushed onto ``versions`` stamped
        with the *pre-edit* ``updated`` time, and only when the body actually
        changed. Tag/rating/notes-only edits do not snapshot — they would flood
        the history with identical bodies. Pass ``snapshot=False`` to skip it
        entirely (restore, rapid retag/rate paths).
        """
        with self._lock:
            self._begin_write()
            rec = self._require(pid)

            if expect_updated is not None and _as_str(expect_updated) != rec.get("updated", ""):
                raise ConflictError(
                    f"record {pid} changed since it was loaded "
                    f"({expect_updated} != {rec.get('updated', '')})"
                )

            merged = dict(rec)
            if body is not None:
                merged["body"] = body
            if tags is not None:
                merged["tags"] = tags
            if rating is not None:
                merged["rating"] = rating
            if notes is not None:
                merged["notes"] = notes
            if pinned is not None:
                merged["pinned"] = pinned
            # Validate before touching anything: a rejected body must not leave
            # the record half-edited.
            cleaned = _clean_record(merged)

            body_changed = cleaned["body"] != rec["body"]
            changed = any(
                cleaned[key] != rec[key] for key in ("body", "tags", "rating", "notes", "pinned")
            )
            if not changed:
                return rec

            if snapshot and body_changed:
                rec["versions"].append(
                    {
                        "body": rec["body"],
                        "ts": rec.get("updated", "") or now_iso(),
                        "src": None,
                    }
                )

            for key in ("body", "tags", "rating", "notes", "pinned"):
                rec[key] = cleaned[key]
            rec["updated"] = now_iso()
            _trim_versions(rec, self._version_cap())

            self._commit_items([(OP_PUT, rec)])
            out = copy.deepcopy(rec)
            self._emit("update", [pid], {pid: out})
            return out

    def set_rating(self, pid, rating):
        """Set a record's rating (0..5, clamped). Never snapshots a version."""
        return self.update(pid, rating=rating, snapshot=False)

    def delete(self, pid):
        """Delete a record. Raises when the id is unknown."""
        with self._lock:
            self._begin_write()
            if pid not in self._entries:
                raise NotFoundError(f"no prompt with id {pid!r}")
            self._commit_items([(OP_DEL, pid)])
            self._drop_pairs({pid})
            self._emit("delete", [pid], {pid: None})
            return True

    def _require(self, pid):
        rec = self.get(pid)
        if rec is None:
            raise NotFoundError(f"no prompt with id {pid!r}")
        return rec

    def bulk_delete(self, ids):
        """Delete many records in one transaction. Returns the number removed."""
        wanted = list(dict.fromkeys(ids))
        with self._lock:
            self._begin_write()
            removed = [pid for pid in wanted if pid in self._entries]
            if not removed:
                return 0
            self._commit_items([(OP_DEL, pid) for pid in removed])
            self._drop_pairs(set(removed))
            self._emit("bulk_delete", removed, dict.fromkeys(removed))
            return len(removed)

    def bulk_retag(self, ids, add=None, remove=None, replace=None):
        """Add / remove / replace tags on many records in one transaction.

        ``replace`` wins over ``add``/``remove`` when given. Returns the number
        of records whose tags actually changed.
        """
        wanted = list(dict.fromkeys(ids))
        add_tags = clean_tags(add or [])
        remove_tags = set(clean_tags(remove or []))
        replace_tags = clean_tags(replace) if replace is not None else None
        with self._lock:
            self._begin_write()
            touched = []
            stamp = now_iso()
            for rec in self._read_records(wanted):
                if replace_tags is not None:
                    new_tags = list(replace_tags)
                else:
                    new_tags = [t for t in rec["tags"] if t not in remove_tags]
                    for tag in add_tags:
                        if tag not in new_tags:
                            new_tags.append(tag)
                new_tags = clean_tags(new_tags)
                if new_tags != rec["tags"]:
                    rec["tags"] = new_tags
                    rec["updated"] = stamp
                    touched.append(rec)
            if not touched:
                return 0
            self._commit_items([(OP_PUT, rec) for rec in touched])
            ids_touched = [rec["id"] for rec in touched]
            self._emit(
                "bulk_retag", ids_touched, {rec["id"]: copy.deepcopy(rec) for rec in touched}
            )
            return len(touched)

    def bulk_merge(self, ids, winner=None):
        """Merge every id into one winner (the first id by default)."""
        order = list(dict.fromkeys(ids))
        if len(order) < 2:
            raise SameRecordError("a merge needs at least two distinct records")
        keeper = winner if winner in order else order[0]
        with self._lock:
            for pid in order:
                if pid != keeper:
                    self.merge(keeper, pid)
            return self.get(keeper)

    def record_usage(self, pid, body=None):
        """Count only runs whose supplied body matches the saved body after whitespace
        normalization, so unsaved edits cannot inflate usage or merge totals.
        """
        with self._lock:
            self._begin_write()
            rec = self.get(pid)
            if rec is None:
                return None
            if body is not None and _as_str(body).strip() != rec["body"].strip():
                return None
            rec["used"] = max(0, _as_int(rec.get("used", 0))) + 1
            rec["last_run"] = now_iso()
            # `updated` is deliberately untouched: a run is not an edit, and
            # bumping it would break expect_updated for an open editor.
            self._commit_items([(OP_PUT, rec)])
            out = copy.deepcopy(rec)
            self._notify(EVENT_USED, {"id": pid, "used": out["used"], "rev": self._rev})
            self._emit("usage", [pid], {pid: out})
            return out

    def versions(self, pid):
        """Full version entries for a record, oldest first (newest last)."""
        return self._require(pid).get("versions", [])

    def version_previews(self, pid, chars=160, label_fn=None):
        """Return previews without full bodies to bound selection responses.
        Inject label_fn(body) so storage stays independent of the corpus index.
        """
        out = []
        for index, entry in enumerate(self.versions(pid)):
            body = entry.get("body", "")
            out.append(
                {
                    "index": index,
                    "label": _as_str(label_fn(body)) if label_fn is not None else "",
                    "ts": entry.get("ts", ""),
                    "src": entry.get("src"),
                    "chars": len(body),
                    "preview": preview_of(body, chars),
                }
            )
        return out

    def version(self, pid, index):
        """One full version entry by index. Raises :class:`~.types.NotFoundError`."""
        entries = self.versions(pid)
        try:
            index = int(index)
        except (TypeError, ValueError) as exc:
            raise NotFoundError(f"bad version index {index!r}") from exc
        if index < 0 or index >= len(entries):
            raise NotFoundError(f"no version {index} on prompt {pid}")
        return entries[index]

    def restore_version(self, pid, index):
        """Snapshot the current body before restoring, so restoration is itself undoable."""
        entry = self.version(pid, index)
        return self.update(pid, body=entry.get("body", ""), snapshot=True)

    def merge(self, winner_id, loser_id):
        """Merge ``loser_id`` into ``winner_id`` and delete the loser.

        The new winner and loser deletion land in one transaction. Arithmetic
        from :func:`~.models._merge_fields`: ``used`` summed, tags unioned
        preserving the winner's order, ``rating`` max, ``created`` min,
        ``last_run`` max, notes appended after a ``\\n---\\n`` rule, ``pinned``
        OR'd. The loser's five most recent versions and then its current body are
        added to the winner's history, all tagged ``src=<loser id>``.
        """
        if winner_id == loser_id:
            raise SameRecordError("cannot merge a record into itself")
        with self._lock:
            self._begin_write()
            winner = self._require(winner_id)
            loser = self._require(loser_id)

            for entry in loser.get("versions", [])[-MERGE_VERSIONS_KEPT:]:
                item = dict(entry)
                item["src"] = loser_id
                winner["versions"].append(item)
            winner["versions"].append(
                {
                    "body": loser["body"],
                    "ts": loser.get("updated", "") or now_iso(),
                    "src": loser_id,
                }
            )

            _merge_fields(winner, loser)
            winner["updated"] = now_iso()
            _trim_versions(winner, self._version_cap())

            self._commit_items([(OP_PUT, winner), (OP_DEL, loser_id)])
            self._drop_pairs({loser_id})
            out = copy.deepcopy(winner)
            self._emit("merge", [winner_id, loser_id], {winner_id: out, loser_id: None})
            return out

    def merge_new(self, a_id, b_id, body):
        """Require an explicit synthesized body; neither input is a safe default."""
        if a_id == b_id:
            raise SameRecordError("cannot merge a record with itself")
        if not _as_str(body).strip():
            raise ValueError("merge_new requires a body")
        with self._lock:
            self._begin_write()
            first = self._require(a_id)
            second = self._require(b_id)

            stamp = now_iso()
            rec = _clean_record(
                {
                    "id": new_id(),
                    "body": body,
                    "tags": list(first["tags"]),
                    "rating": first["rating"],
                    "used": first["used"],
                    "last_run": first["last_run"],
                    "created": first["created"],
                    "updated": stamp,
                    "notes": first["notes"],
                    "pinned": first["pinned"],
                    "versions": [],
                }
            )
            for source in (first, second):
                for entry in source.get("versions", [])[-MERGE_VERSIONS_KEPT:]:
                    item = dict(entry)
                    item["src"] = source["id"]
                    rec["versions"].append(item)
                rec["versions"].append(
                    {
                        "body": source["body"],
                        "ts": source.get("updated", "") or stamp,
                        "src": source["id"],
                    }
                )
            _merge_fields(rec, second)
            rec["updated"] = stamp
            _trim_versions(rec, self._version_cap())

            self._commit_items([(OP_PUT, rec), (OP_DEL, a_id), (OP_DEL, b_id)])
            self._drop_pairs({a_id, b_id})
            out = copy.deepcopy(rec)
            self._emit(
                "merge_new", [rec["id"], a_id, b_id], {rec["id"]: out, a_id: None, b_id: None}
            )
            return out

    def tags(self):
        """Derived tag counts, most used first. From the index; no body is read."""
        self.ensure_loaded()
        with self._lock:
            counts = {}
            for entry in self._entries.values():
                for tag in entry.get("tags", ()):
                    counts[tag] = counts.get(tag, 0) + 1
        return [
            {"tag": tag, "count": count}
            for tag, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

    def taxonomy(self):
        """Everything the filter rail needs: the tags, with counts."""
        return {"tags": self.tags(), "total": self.count()}

    def snippets(self):
        """Return a copy of ``{name: {"body": ..., "updated": ...}}``."""
        self.ensure_loaded()
        with self._lock:
            return copy.deepcopy(self._meta["snippets"])

    def get_snippet(self, name):
        """Return one snippet's body, or ``None`` when it does not exist."""
        key = _as_str(name).strip()
        self.ensure_loaded()
        with self._lock:
            entry = self._meta["snippets"].get(key)
            return entry.get("body", "") if isinstance(entry, dict) else None

    def set_snippet(self, name, body):
        """Create or replace a snippet. Returns the stored entry."""
        key = _as_str(name).strip()[:MAX_SNIPPET_NAME_CHARS]
        if not key:
            raise ValueError("snippet name is empty")
        text = clean_body(body)
        with self._lock:
            self._begin_write()
            entry = {"body": text, "updated": now_iso()}
            self._meta["snippets"][key] = entry
            self._save_meta()
            self._emit("snippet", [], {})
            return dict(entry)

    def delete_snippet(self, name):
        """Delete a snippet. Raises :class:`~.types.NotFoundError` when missing."""
        key = _as_str(name).strip()
        with self._lock:
            self._begin_write()
            if key not in self._meta["snippets"]:
                raise NotFoundError(f"no snippet named {key!r}")
            del self._meta["snippets"][key]
            self._save_meta()
            self._emit("snippet", [], {})
            return True

    def _drop_pairs(self, ids):
        """Forget every muted pair mentioning a now-deleted id."""
        kept = [p for p in self._meta["ignored"] if p[0] not in ids and p[1] not in ids]
        if len(kept) != len(self._meta["ignored"]):
            self._meta["ignored"] = kept
            self._save_meta()

    def ignore_pair(self, a, b):
        """Store sorted pairs so keep-both decisions are order-independent."""
        first, second = _as_str(a), _as_str(b)
        if not first or not second or first == second:
            raise ValueError("ignore_pair needs two distinct ids")
        key = sorted((first, second))
        with self._lock:
            self._begin_write()
            if any(list(pair) == key for pair in self._meta["ignored"]):
                return False
            self._meta["ignored"].append(key)
            self._save_meta()
            self._emit("ignore", [first, second], {})
            return True

    def unignore_pair(self, a, b):
        """Forget a "keep both" decision so the pair is reported again."""
        key = sorted((_as_str(a), _as_str(b)))
        with self._lock:
            self._begin_write()
            kept = [p for p in self._meta["ignored"] if list(p) != key]
            if len(kept) == len(self._meta["ignored"]):
                return False
            self._meta["ignored"] = kept
            self._save_meta()
            self._emit("ignore", [key[0], key[1]], {})
            return True

    def is_ignored(self, a, b):
        """True when the user chose "keep both" for this (unordered) pair."""
        key = sorted((_as_str(a), _as_str(b)))
        self.ensure_loaded()
        with self._lock:
            return any(list(pair) == key for pair in self._meta["ignored"])

    def ignored_pairs(self):
        """All ignored pairs as a set of ``(lo, hi)`` tuples (O(1) membership)."""
        self.ensure_loaded()
        with self._lock:
            return {(p[0], p[1]) for p in self._meta["ignored"] if len(p) == 2}

    def export_raw(self):
        """Export a portable JSON envelope from the authoritative SQLite store."""
        self.ensure_loaded()
        with self._lock:
            return envelope_from_parts(
                settings=self._meta["settings"],
                snippets=self._meta["snippets"],
                ignored=self._meta["ignored"],
                prompts=self.all(),
                updated=self._meta.get("updated", ""),
                schema=self._meta.get("schema", SCHEMA_VERSION),
            )

    def export_metadata(self):
        """The portable envelope without ``prompts``, for streamed exports."""
        self.ensure_loaded()
        with self._lock:
            return copy.deepcopy(
                {
                    "schema": self._meta.get("schema", SCHEMA_VERSION),
                    "updated": self._meta.get("updated", ""),
                    "settings": self._meta["settings"],
                    "snippets": self._meta["snippets"],
                    "ignored": self._meta["ignored"],
                }
            )

    def import_raw(self, raw, replace=True):
        """Import an envelope (coerced first, so any junk is survivable).

        ``replace=True`` atomically rewrites the library with incoming records,
        so an import cannot leave the old library as garbage to compact later.
        ``replace=False`` merges: records whose id already exists are given a
        fresh id rather than clobbering the resident record, and snippets and
        muted pairs are unioned. Returns the number of records imported.
        """
        incoming = _coerce(raw)
        with self._lock:
            self._begin_write()
            if replace:
                previous_meta = copy.deepcopy(self._meta)
                try:
                    self._meta["settings"] = incoming["settings"]
                    self._meta["snippets"] = incoming["snippets"]
                    self._meta["ignored"] = incoming["ignored"]
                    self._meta["updated"] = now_iso()
                    self._replace_library(incoming["prompts"])
                except Exception:
                    self._meta = previous_meta
                    raise
            else:
                for name, entry in incoming["snippets"].items():
                    self._meta["snippets"].setdefault(name, entry)
                have = {tuple(p) for p in self._meta["ignored"]}
                for pair in incoming["ignored"]:
                    if tuple(pair) not in have:
                        self._meta["ignored"].append(pair)
                self._save_meta()
                for rec in incoming["prompts"]:
                    if rec["id"] in self._entries:
                        rec["id"] = new_id()
                self._commit_items([(OP_PUT, rec) for rec in incoming["prompts"]])
            self._emit("import", [], {})
            return len(incoming["prompts"])
