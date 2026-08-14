"""Prompt Librarian — the library file, its schema and all mutations.

This is the storage half of the ``PromptLibrarian`` node. It is deliberately
independent of the older ``prompt_store`` module: that one keys prompts by their
own text (``{category: [text, ...]}``), which makes two near-identical prompts
literally unrepresentable — precisely the thing this feature exists to manage.
Here every prompt is a record with a stable id, a name, tags, a rating, usage
counters and a version history.

Everything lives in one json file under ComfyUI's user directory::

    <user>/default/prompt-librarian/library.json

On-disk format::

    {
      "schema": 1,
      "updated": "2026-08-13T18:20:00Z",
      "settings": { "dupe_threshold": 0.9, "version_cap": 50 },
      "categories": ["videogen_edit_minimax"],
      "snippets": { "cine_lighting": { "body": "volumetric haze", "updated": "..." } },
      "ignored": [["idA", "idB"]],
      "prompts": [{
        "id": "9f2c1b7e...",            // uuid4().hex
        "name": "ballet_drift_v3",
        "body": "make him dance ballet ...",
        "category": "videogen_edit_minimax",
        "tags": ["dance", "camera-move"],
        "rating": 4,
        "used": 41,
        "last_run": "2026-08-11T19:03:22Z",
        "created": "...", "updated": "...",
        "notes": "", "pinned": false,
        "versions": [{ "body": "...", "name": "...", "ts": "...", "src": null }]
      }]
    }

Design notes worth keeping in mind before editing this file:

* **``id`` is ``uuid4().hex``, never a content hash.** Two records with identical
  bodies must be able to coexist until the user explicitly merges them, and an
  id must survive a body edit so a saved workflow's ``prompt_id`` link holds.
* **Tags are derived** from the records (a ``Counter``), never stored top level —
  a stored list drifts and would need garbage collection. **Categories *are*
  stored**, so an empty category can exist and a rename is one atomic operation;
  the effective set on read is ``stored | observed``, so a hand-edited file
  self-heals.
* **Reload-before-mutate.** Every write re-stats the file and reloads if it
  changed, then mutates the freshly loaded object. Cross-process editing then
  degrades to per-record last-writer-wins instead of clobbering the whole file.
* **Serialize first, then touch the disk.** ``json.dumps`` runs before the backup
  copy and before the temp file is opened, so a serialization failure can never
  leave a truncated library behind.
* **Corruption is never destructive.** An unreadable file loads as empty and is
  *renamed* to ``library.corrupt-<epoch>.json`` on the first subsequent save, so
  the user keeps their data and can hand-repair it.

Nothing in this module touches the filesystem at import time, and nothing here
imports ComfyUI: ``folder_paths`` is optional so the module (and its tests) run
headless.
"""

import contextlib
import copy
import itertools
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone

try:  # ComfyUI is optional: the module must import headless for tests/tools.
    import folder_paths
except ImportError:  # pragma: no cover - exercised by the test stub instead
    folder_paths = None

log = logging.getLogger("prompt-librarian")

SCHEMA_VERSION = 1

MAX_BODY_CHARS = 100000
MAX_NAME_CHARS = 200
MAX_CATEGORY_CHARS = 100
MAX_SNIPPET_NAME_CHARS = 100
MAX_TAG_CHARS = 40
MAX_TAGS = 32

VERSION_CAP = 50
VERSION_BYTES_CAP = 262144  # 256 KB of version bodies per record
MERGE_VERSIONS_KEPT = 5     # of the loser's own history, on merge

DEFAULT_DUPE_THRESHOLD = 0.90

REPLACE_RETRIES = 3
REPLACE_BACKOFF = 0.06  # 60 ms; Windows AV/Explorer lock the target transiently

# Used only when ComfyUI's `folder_paths` is unavailable (headless tools, tests).
# Tests override this, or hand the store an explicit `path=`.
_FALLBACK_USER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_user")

_EVENT_CHANGED = "prompt_librarian.changed"
_EVENT_USED = "prompt_librarian.used"

_WS_RE = re.compile(r"\s+", re.UNICODE)
_tmp_counter = itertools.count()


# --------------------------------------------------------------------------- #
# Errors — the api layer maps these onto HTTP codes, so the names are contract.
# --------------------------------------------------------------------------- #

class StoreError(Exception):
    """Base class for every error this module raises deliberately."""


class NotFoundError(StoreError):
    """No record / version / snippet with that id or name (HTTP 404)."""


class BodyTooLargeError(StoreError):
    """A body exceeds ``MAX_BODY_CHARS``. Bodies are rejected, never truncated (413)."""


class ReadOnlyError(StoreError):
    """The library on disk has a newer ``schema`` than this build understands (409)."""


class StoreWriteError(StoreError):
    """The library could not be written to disk (500)."""


class SameRecordError(StoreError):
    """A merge was asked to merge a record with itself (400)."""


class ConflictError(StoreError):
    """``expect_updated`` did not match the record's current ``updated`` (409)."""


# --------------------------------------------------------------------------- #
# Paths — resolved lazily, inside functions. Never at import time: ComfyUI sets
# its user directory up after our module is imported.
# --------------------------------------------------------------------------- #

def user_dir():
    """ComfyUI's user directory, or ``_FALLBACK_USER_DIR`` when running headless."""
    if folder_paths is not None:
        try:
            return folder_paths.get_user_directory()
        except Exception:  # a broken/partial stub must not break the store
            log.debug("folder_paths.get_user_directory() failed", exc_info=True)
    return _FALLBACK_USER_DIR


def store_dir():
    """Directory holding ``library.json``, its backup and the wildcards folder."""
    return os.path.join(user_dir(), "default", "prompt-librarian")


def store_path():
    """Absolute path of the library file."""
    return os.path.join(store_dir(), "library.json")


def backup_path():
    """Absolute path of the copy taken immediately before every save."""
    return os.path.join(store_dir(), "library.bak.json")


def wildcards_dir():
    """Absolute path of the ``__wildcard__`` text-file directory."""
    return os.path.join(store_dir(), "wildcards")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def now_iso():
    """Current UTC time as ``2026-08-13T18:20:00Z``.

    Second precision with a literal ``Z``: these strings are compared and sorted
    lexicographically all over the search/merge code, which only works if every
    timestamp in the file has exactly the same shape.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id():
    """A fresh record id. uuid4 — see the module docstring for why not a hash."""
    return uuid.uuid4().hex


def preview_of(text, chars=160):
    """One-line, length-capped excerpt of ``text`` for list rows and version lists."""
    flat = _WS_RE.sub(" ", str(text or "")).strip()
    return flat[:chars]


def _as_str(value, default=""):
    if isinstance(value, str):
        return value
    if value is None:
        return default
    return str(value)


def _as_int(value, default=0):
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _clamp(value, low, high):
    return low if value < low else (high if value > high else value)


def clean_tag(tag):
    """Normalize one tag: casefolded, whitespace collapsed to ``-``, length capped.

    ``casefold()`` rather than ``lower()`` so ``ß``/``SS`` and Turkish dotted I
    behave; the same normalization is applied to every tag query, so filters and
    stored tags can never disagree.
    """
    text = _WS_RE.sub("-", _as_str(tag).strip()).casefold()
    return text[:MAX_TAG_CHARS]


def clean_tags(tags):
    """Normalize a tag list: cleaned, empties dropped, deduped in order, ≤32 kept."""
    if isinstance(tags, str):
        tags = list(re.split(r"[,\n]", tags))
    if not isinstance(tags, (list, tuple, set, frozenset)):
        return []
    out = []
    seen = set()
    for raw in tags:
        tag = clean_tag(raw)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
        if len(out) >= MAX_TAGS:
            break
    return out


def clean_name(name, body=""):
    """Strip and cap a name, falling back to a body-derived label when empty.

    A record with no name is unusable in the list, so an empty name is filled in
    rather than rejected.
    """
    text = _WS_RE.sub(" ", _as_str(name)).strip()[:MAX_NAME_CHARS]
    if text:
        return text
    text = preview_of(body, 40).strip()
    return text or "untitled"


def clean_category(category):
    """Strip and cap a category name (``""`` means uncategorized)."""
    return _WS_RE.sub(" ", _as_str(category)).strip()[:MAX_CATEGORY_CHARS]


def clean_body(body):
    """Validate a body. Raises :class:`BodyTooLargeError` — never truncates."""
    text = _as_str(body)
    if len(text) > MAX_BODY_CHARS:
        raise BodyTooLargeError(
            f"body is {len(text)} characters, the limit is {MAX_BODY_CHARS}"
        )
    return text


def _clean_record(rec):
    """Return a normalized copy of a record dict, preserving unknown keys.

    Raises :class:`BodyTooLargeError` for an oversized body. Called *before* any
    mutation of the live library so a rejected edit cannot half-apply.
    """
    out = dict(rec)
    out["id"] = _as_str(rec.get("id")) or new_id()
    out["body"] = clean_body(rec.get("body", ""))
    out["name"] = clean_name(rec.get("name", ""), out["body"])
    out["category"] = clean_category(rec.get("category", ""))
    out["tags"] = clean_tags(rec.get("tags", []))
    out["rating"] = _clamp(_as_int(rec.get("rating", 0)), 0, 5)
    out["used"] = max(0, _as_int(rec.get("used", 0)))
    out["notes"] = _as_str(rec.get("notes", ""))
    out["pinned"] = bool(rec.get("pinned", False))
    out["last_run"] = _as_str(rec.get("last_run", ""))
    out["created"] = _as_str(rec.get("created", "")) or now_iso()
    out["updated"] = _as_str(rec.get("updated", "")) or out["created"]
    out["versions"] = _coerce_versions(rec.get("versions", []))
    return out


def _coerce_versions(raw):
    """Tolerant coercion of a ``versions`` list (drops entries that make no sense)."""
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        item["body"] = _as_str(entry.get("body", ""))
        item["name"] = _as_str(entry.get("name", ""))
        item["ts"] = _as_str(entry.get("ts", ""))
        src = entry.get("src")
        item["src"] = _as_str(src) if isinstance(src, str) and src else None
        out.append(item)
    return out


def _coerce_record(raw):
    """Tolerant coercion of one on-disk record. Never raises.

    Unlike :func:`_clean_record` this accepts an oversized body: a hand-edited
    file must load, and refusing to show the user their own data would be worse
    than holding a too-long body in memory. The next *edit* of that record still
    has to pass the limit.
    """
    if not isinstance(raw, dict):
        return None
    out = dict(raw)
    out["id"] = _as_str(raw.get("id")) or new_id()
    out["body"] = _as_str(raw.get("body", ""))
    out["name"] = clean_name(raw.get("name", ""), out["body"])
    out["category"] = clean_category(raw.get("category", ""))
    out["tags"] = clean_tags(raw.get("tags", []))
    out["rating"] = _clamp(_as_int(raw.get("rating", 0)), 0, 5)
    out["used"] = max(0, _as_int(raw.get("used", 0)))
    out["notes"] = _as_str(raw.get("notes", ""))
    out["pinned"] = bool(raw.get("pinned", False))
    out["last_run"] = _as_str(raw.get("last_run", ""))
    out["created"] = _as_str(raw.get("created", "")) or now_iso()
    out["updated"] = _as_str(raw.get("updated", "")) or out["created"]
    out["versions"] = _coerce_versions(raw.get("versions", []))
    return out


def empty_envelope():
    """A fresh, valid, empty library envelope."""
    return {
        "schema": SCHEMA_VERSION,
        "updated": now_iso(),
        "settings": {
            "dupe_threshold": DEFAULT_DUPE_THRESHOLD,
            "version_cap": VERSION_CAP,
        },
        "categories": [],
        "snippets": {},
        "ignored": [],
        "prompts": [],
    }


def _coerce(raw):  # noqa: C901 - one field-by-field migration of a raw record
    """Coerce anything at all into a valid envelope. **Never raises.**

    Total tolerance is the point: this runs on whatever json happened to be on
    disk, including a file a human edited by hand. Unknown top-level and
    per-record keys are preserved verbatim so a newer build's extra fields
    survive a round-trip through an older one.
    """
    env = empty_envelope()
    if not isinstance(raw, dict):
        return env

    out = dict(raw)  # keep unknown keys

    schema = raw.get("schema", SCHEMA_VERSION)
    out["schema"] = _as_int(schema, SCHEMA_VERSION)
    out["updated"] = _as_str(raw.get("updated", "")) or now_iso()

    settings = raw.get("settings")
    merged = dict(settings) if isinstance(settings, dict) else {}
    threshold = merged.get("dupe_threshold", DEFAULT_DUPE_THRESHOLD)
    try:
        threshold = float(threshold)
    except (TypeError, ValueError):
        threshold = DEFAULT_DUPE_THRESHOLD
    merged["dupe_threshold"] = _clamp(threshold, 0.0, 1.0)
    merged["version_cap"] = _clamp(
        _as_int(merged.get("version_cap", VERSION_CAP), VERSION_CAP), 1, 1000
    )
    out["settings"] = merged

    cats = []
    seen_cats = set()
    raw_cats = raw.get("categories")
    if isinstance(raw_cats, (list, tuple)):
        for c in raw_cats:
            name = clean_category(c)
            if name and name not in seen_cats:
                seen_cats.add(name)
                cats.append(name)
    out["categories"] = cats

    snippets = {}
    raw_snips = raw.get("snippets")
    if isinstance(raw_snips, dict):
        for key, value in raw_snips.items():
            name = _as_str(key).strip()[:MAX_SNIPPET_NAME_CHARS]
            if not name:
                continue
            if isinstance(value, str):
                snippets[name] = {"body": value, "updated": now_iso()}
            elif isinstance(value, dict):
                item = dict(value)
                item["body"] = _as_str(value.get("body", ""))
                item["updated"] = _as_str(value.get("updated", "")) or now_iso()
                snippets[name] = item
    out["snippets"] = snippets

    ignored = []
    seen_pairs = set()
    raw_ignored = raw.get("ignored")
    if isinstance(raw_ignored, (list, tuple)):
        for pair in raw_ignored:
            if not isinstance(pair, (list, tuple)) or len(pair) != 2:
                continue
            a, b = _as_str(pair[0]), _as_str(pair[1])
            if not a or not b or a == b:
                continue
            key = tuple(sorted((a, b)))
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            ignored.append([key[0], key[1]])
    out["ignored"] = ignored

    prompts = []
    seen_ids = set()
    raw_prompts = raw.get("prompts")
    if isinstance(raw_prompts, (list, tuple)):
        for entry in raw_prompts:
            rec = _coerce_record(entry)
            if rec is None:
                continue
            if rec["id"] in seen_ids:  # a duplicated id would shadow a record
                rec["id"] = new_id()
            seen_ids.add(rec["id"])
            prompts.append(rec)
    out["prompts"] = prompts

    return out


# --------------------------------------------------------------------------- #
# The store
# --------------------------------------------------------------------------- #

class LibrarianStore:
    """The prompt library: one json file, one in-memory copy, one lock.

    Thread safety: every public method takes a single ``threading.RLock``. It is
    re-entrant because the compound operations (``merge`` → ``update`` →
    snapshot, ``bulk_merge`` → ``merge``) all want the same lock. aiohttp
    handlers, executor threads and ComfyUI's prompt worker all reach this object.

    ``path`` overrides the resolved library location; that is how tests point the
    store at a temp directory without a real ComfyUI user directory in sight.
    """

    def __init__(self, path=None):
        self._path = path
        self._lock = threading.RLock()
        self._data = None
        self._by_id = {}
        self._sig = None        # (st_mtime_ns, st_size) of the file we loaded
        self._rev = 0           # monotonic; bumped on every load and save
        self._corrupt = False
        self._readonly = False
        self._listeners = []

    # -- paths ------------------------------------------------------------- #

    def store_path(self):
        """Absolute path of this store's library file."""
        return self._path if self._path else store_path()

    def store_dir(self):
        """Directory containing this store's library file."""
        return os.path.dirname(os.path.abspath(self.store_path()))

    def backup_path(self):
        """Path of the ``.bak.json`` copy taken before each save."""
        base, _ = os.path.splitext(os.path.basename(self.store_path()))
        return os.path.join(self.store_dir(), base + ".bak.json")

    def corrupt_path(self):
        """Quarantine path for an unreadable library file (epoch-stamped)."""
        base, _ = os.path.splitext(os.path.basename(self.store_path()))
        return os.path.join(self.store_dir(), f"{base}.corrupt-{int(time.time())}.json")

    def wildcards_dir(self):
        """Directory holding ``__wildcard__`` text files for this store."""
        return os.path.join(self.store_dir(), "wildcards")

    # -- state ------------------------------------------------------------- #

    def rev(self):
        """Monotonic revision counter, bumped on every load and every save.

        Search and dedupe cache on this value, and every api response echoes it.
        """
        with self._lock:
            return self._rev

    def is_corrupt(self):
        """True when the library on disk failed to parse and we loaded empty."""
        with self._lock:
            return self._corrupt

    def is_readonly(self):
        """True when the file's ``schema`` is newer than this build; writes refuse."""
        self.ensure_loaded()
        with self._lock:
            return self._readonly

    def on_change(self, callback):
        """Register ``cb(op, ids, records)``; returns a function that unregisters it.

        Called after a *successful* save. ``records`` maps id → the new record
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

    # -- load / save ------------------------------------------------------- #

    def ensure_loaded(self, force=False):
        """Load the library if needed. The fast path is a single ``os.stat``.

        A reload happens only when ``(st_mtime_ns, st_size)`` differs from the
        signature of the file we last read, so calling this at the top of every
        public method costs one stat.
        """
        with self._lock:
            path = self.store_path()
            try:
                st = os.stat(path)
                sig = (st.st_mtime_ns, st.st_size)
            except OSError:
                sig = None
            if self._data is not None and not force and sig == self._sig:
                return self._data
            self._load_locked(path, sig)
            return self._data

    def _load_locked(self, path, sig):
        raw = None
        corrupt = False
        if sig is not None:
            try:
                with open(path, encoding="utf-8") as handle:
                    raw = json.load(handle)
            except (OSError, ValueError) as exc:
                log.warning("[prompt-librarian] unreadable library at %s: %s", path, exc)
                corrupt = True
            else:
                if not isinstance(raw, dict):
                    log.warning("[prompt-librarian] library root is not an object: %s", path)
                    corrupt = True
        if corrupt:
            raw = None
        self._data = _coerce(raw)
        self._corrupt = corrupt
        self._readonly = _as_int(self._data.get("schema"), SCHEMA_VERSION) > SCHEMA_VERSION
        self._sig = sig
        self._rev += 1
        self._reindex()

    def _reindex(self):
        self._by_id = {rec["id"]: rec for rec in self._data.get("prompts", [])}

    def _begin_write(self):
        """Reload if the file changed, refuse if read-only, return a working copy.

        The copy matters: every mutation happens off to the side and only becomes
        the in-memory library once the save has actually landed, so a rejected
        edit (oversized body, failed write) leaves no trace.
        """
        self.ensure_loaded()
        if self._readonly:
            raise ReadOnlyError(
                f"library.json declares schema {self._data.get('schema')}, "
                f"this build understands {SCHEMA_VERSION}"
            )
        return copy.deepcopy(self._data)

    def _save_locked(self, data):  # noqa: C901 - the write path, error branch by error branch
        """Atomically write ``data``, then adopt it as the in-memory library."""
        if self._readonly:
            raise ReadOnlyError("library is read-only (newer schema on disk)")

        data["updated"] = now_iso()
        # Serialize FIRST. A json.dumps failure must never reach the disk.
        try:
            text = json.dumps(data, ensure_ascii=False, indent=2)
        except (TypeError, ValueError) as exc:
            raise StoreWriteError(f"library could not be serialized: {exc}") from exc

        path = self.store_path()
        directory = self.store_dir()
        try:
            os.makedirs(directory, exist_ok=True)
        except OSError as exc:
            raise StoreWriteError(f"cannot create {directory}: {exc}") from exc

        if self._corrupt and os.path.exists(path):
            # Never overwrite a file we failed to parse — the user's data may be
            # recoverable by hand. Move it aside once, then write normally.
            quarantine = self.corrupt_path()
            try:
                os.replace(path, quarantine)
                log.warning("[prompt-librarian] corrupt library preserved as %s", quarantine)
            except OSError as exc:
                log.warning("[prompt-librarian] could not quarantine %s: %s", path, exc)
            self._corrupt = False
        elif os.path.exists(path):
            try:
                shutil.copyfile(path, self.backup_path())
            except OSError as exc:  # a missing backup is not worth failing a save
                log.warning("[prompt-librarian] backup failed: %s", exc)

        tmp = os.path.join(
            directory,
            f"{os.path.basename(path)}.tmp-{os.getpid()}-{next(_tmp_counter)}",
        )
        try:
            with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            _silent_unlink(tmp)
            raise StoreWriteError(f"cannot write {tmp}: {exc}") from exc

        last = None
        for attempt in range(REPLACE_RETRIES):
            try:
                os.replace(tmp, path)
                last = None
                break
            except PermissionError as exc:
                # Windows: AV scanners and Explorer hold the target open briefly.
                last = exc
                if attempt + 1 < REPLACE_RETRIES:
                    time.sleep(REPLACE_BACKOFF)
            except OSError as exc:
                last = exc
                break
        if last is not None:
            _silent_unlink(tmp)
            raise StoreWriteError(f"cannot replace {path}: {last}") from last

        self._data = data
        try:
            st = os.stat(path)
            self._sig = (st.st_mtime_ns, st.st_size)
        except OSError:
            self._sig = None
        self._rev += 1
        self._reindex()

    # -- notification ------------------------------------------------------ #

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
        self._notify(_EVENT_CHANGED, {"op": op, "ids": list(ids), "rev": self._rev})

    # -- lookups ----------------------------------------------------------- #

    def _find(self, data, pid):
        for rec in data.get("prompts", []):
            if rec.get("id") == pid:
                return rec
        return None

    def _require(self, data, pid):
        rec = self._find(data, pid)
        if rec is None:
            raise NotFoundError(f"no prompt with id {pid!r}")
        return rec

    def get(self, pid):
        """Return a copy of one record, or ``None`` when the id is unknown."""
        self.ensure_loaded()
        with self._lock:
            rec = self._by_id.get(pid)
            return copy.deepcopy(rec) if rec is not None else None

    def get_many(self, ids):
        """Return ``{id: record}`` for the ids that exist (batch node-face fetch)."""
        self.ensure_loaded()
        with self._lock:
            out = {}
            for pid in ids:
                rec = self._by_id.get(pid)
                if rec is not None:
                    out[pid] = copy.deepcopy(rec)
            return out

    def all(self):
        """Return copies of every record, in file order."""
        self.ensure_loaded()
        with self._lock:
            return copy.deepcopy(self._data.get("prompts", []))

    # ``librarian_search`` and ``librarian_dedupe`` duck-type a store as
    # ``rev()`` + ``list_all()``. Keeping the alias here (rather than renaming
    # ``all()``) means either name works from any call site.
    list_all = all  # noqa: A003 - `all` is the collection API name, not the builtin

    def count(self):
        """Number of records in the library."""
        self.ensure_loaded()
        with self._lock:
            return len(self._data.get("prompts", []))

    def settings(self):
        """Return a copy of the settings block."""
        self.ensure_loaded()
        with self._lock:
            return dict(self._data.get("settings", {}))

    def set_settings(self, dupe_threshold=None, version_cap=None):
        """Update the persisted settings; returns the new settings block."""
        with self._lock:
            data = self._begin_write()
            settings = data.setdefault("settings", {})
            if dupe_threshold is not None:
                try:
                    settings["dupe_threshold"] = _clamp(float(dupe_threshold), 0.0, 1.0)
                except (TypeError, ValueError) as exc:
                    raise ValueError("dupe_threshold must be a number in 0..1") from exc
            if version_cap is not None:
                settings["version_cap"] = _clamp(_as_int(version_cap, VERSION_CAP), 1, 1000)
            self._save_locked(data)
            self._emit("settings", [], {})
            return dict(self._data.get("settings", {}))

    def _version_cap(self, data):
        settings = data.get("settings", {})
        return _clamp(_as_int(settings.get("version_cap", VERSION_CAP), VERSION_CAP), 1, 1000)

    # -- create / update / delete ------------------------------------------ #

    def create(self, name="", body="", category="", tags=None, rating=0,
               notes="", pinned=False):
        """Create a record and return a copy of it.

        The body is validated (``BodyTooLargeError``) before anything is written.
        """
        with self._lock:
            data = self._begin_write()
            stamp = now_iso()
            rec = _clean_record({
                "id": new_id(),
                "name": name,
                "body": body,
                "category": category,
                "tags": tags or [],
                "rating": rating,
                "used": 0,
                "last_run": "",
                "created": stamp,
                "updated": stamp,
                "notes": notes,
                "pinned": pinned,
                "versions": [],
            })
            data["prompts"].append(rec)
            self._register_category(data, rec["category"])
            self._save_locked(data)
            out = copy.deepcopy(rec)
            self._emit("create", [rec["id"]], {rec["id"]: out})
            return out

    def update(self, pid, name=None, body=None, category=None, tags=None,
               rating=None, notes=None, pinned=None, snapshot=True,
               expect_updated=None):
        """Update the given fields of a record and return a copy of it.

        Only the arguments that are not ``None`` are applied.

        ``expect_updated`` is the optimistic-concurrency check: pass the
        ``updated`` timestamp the caller loaded and a mismatch raises
        :class:`ConflictError` instead of silently overwriting a change made in
        another tab or process.

        Snapshot rule: the *pre-edit* body/name is pushed onto ``versions``
        stamped with the *pre-edit* ``updated`` time, and only when the body or
        the name actually changed. Tag/rating/category/notes-only edits do not
        snapshot — they would flood the history with identical bodies. Pass
        ``snapshot=False`` to skip it entirely (restore, rapid retag/rate paths).
        """
        with self._lock:
            data = self._begin_write()
            rec = self._require(data, pid)

            if expect_updated is not None and _as_str(expect_updated) != rec.get("updated", ""):
                raise ConflictError(
                    f"record {pid} changed since it was loaded "
                    f"({expect_updated} != {rec.get('updated', '')})"
                )

            merged = dict(rec)
            if name is not None:
                merged["name"] = name
            if body is not None:
                merged["body"] = body
            if category is not None:
                merged["category"] = category
            if tags is not None:
                merged["tags"] = tags
            if rating is not None:
                merged["rating"] = rating
            if notes is not None:
                merged["notes"] = notes
            if pinned is not None:
                merged["pinned"] = pinned
            # Validate before touching the live copy: a rejected body must not
            # leave the record half-edited.
            cleaned = _clean_record(merged)

            body_changed = cleaned["body"] != rec["body"]
            name_changed = cleaned["name"] != rec["name"]
            changed = any(
                cleaned[key] != rec[key]
                for key in ("body", "name", "category", "tags", "rating", "notes", "pinned")
            )
            if not changed:
                return copy.deepcopy(rec)

            if snapshot and (body_changed or name_changed):
                rec["versions"].append({
                    "body": rec["body"],
                    "name": rec["name"],
                    "ts": rec.get("updated", "") or now_iso(),
                    "src": None,
                })

            for key in ("body", "name", "category", "tags", "rating", "notes", "pinned"):
                rec[key] = cleaned[key]
            rec["updated"] = now_iso()
            _trim_versions(rec, self._version_cap(data))
            self._register_category(data, rec["category"])

            self._save_locked(data)
            out = copy.deepcopy(self._by_id[pid])
            self._emit("update", [pid], {pid: out})
            return out

    def set_rating(self, pid, rating):
        """Set a record's rating (0..5, clamped). Never snapshots a version."""
        return self.update(pid, rating=rating, snapshot=False)

    def delete(self, pid):
        """Delete a record. Raises :class:`NotFoundError` when the id is unknown."""
        with self._lock:
            data = self._begin_write()
            self._require(data, pid)
            data["prompts"] = [r for r in data["prompts"] if r.get("id") != pid]
            _drop_pairs(data, {pid})
            self._save_locked(data)
            self._emit("delete", [pid], {pid: None})
            return True

    # -- bulk -------------------------------------------------------------- #

    def bulk_delete(self, ids):
        """Delete many records in one save. Returns the number actually removed."""
        wanted = list(dict.fromkeys(ids))
        with self._lock:
            data = self._begin_write()
            present = {r["id"] for r in data["prompts"]} & set(wanted)
            if not present:
                return 0
            data["prompts"] = [r for r in data["prompts"] if r["id"] not in present]
            _drop_pairs(data, present)
            self._save_locked(data)
            removed = [pid for pid in wanted if pid in present]
            self._emit("bulk_delete", removed, dict.fromkeys(removed))
            return len(removed)

    def bulk_retag(self, ids, add=None, remove=None, replace=None):
        """Add / remove / replace tags on many records in one save.

        ``replace`` wins over ``add``/``remove`` when given. Returns the number
        of records whose tags actually changed.
        """
        wanted = set(ids)
        add_tags = clean_tags(add or [])
        remove_tags = set(clean_tags(remove or []))
        replace_tags = clean_tags(replace) if replace is not None else None
        with self._lock:
            data = self._begin_write()
            touched = []
            for rec in data["prompts"]:
                if rec["id"] not in wanted:
                    continue
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
                    rec["updated"] = now_iso()
                    touched.append(rec["id"])
            if not touched:
                return 0
            self._save_locked(data)
            self._emit(
                "bulk_retag", touched, {pid: copy.deepcopy(self._by_id[pid]) for pid in touched}
            )
            return len(touched)

    def bulk_categorize(self, ids, category):
        """Move many records into ``category`` in one save. Returns the count changed."""
        wanted = set(ids)
        target = clean_category(category)
        with self._lock:
            data = self._begin_write()
            touched = []
            for rec in data["prompts"]:
                if rec["id"] in wanted and rec["category"] != target:
                    rec["category"] = target
                    rec["updated"] = now_iso()
                    touched.append(rec["id"])
            if not touched:
                return 0
            self._register_category(data, target)
            self._save_locked(data)
            self._emit("bulk_categorize", touched,
                       {pid: copy.deepcopy(self._by_id[pid]) for pid in touched})
            return len(touched)

    def bulk_merge(self, ids, winner=None):
        """Merge every id into one winner (the first id by default).

        Implemented as repeated :meth:`merge` calls under the one re-entrant
        lock: each is a separate save, which keeps the merge arithmetic in a
        single place at the cost of n writes for an operation the user performs
        on a handful of records at a time.
        """
        order = list(dict.fromkeys(ids))
        if len(order) < 2:
            raise SameRecordError("a merge needs at least two distinct records")
        keeper = winner if winner in order else order[0]
        with self._lock:
            for pid in order:
                if pid != keeper:
                    self.merge(keeper, pid)
            return self.get(keeper)

    # -- usage ------------------------------------------------------------- #

    def record_usage(self, pid, body=None):
        """Count one run of a saved prompt. Returns the record, or ``None``.

        Returns ``None`` and writes *nothing at all* when the id is unknown or
        when ``body`` does not match the stored body (whitespace-insensitively).
        ``used`` drives the "most used" sort and is summed on merge, so it has to
        mean "this exact saved body ran"; counting edited-but-unsaved text would
        permanently skew both with no audit trail.
        """
        with self._lock:
            self.ensure_loaded()
            current = self._by_id.get(pid)
            if current is None:
                return None
            if body is not None and _as_str(body).strip() != current["body"].strip():
                return None
            data = self._begin_write()
            rec = self._find(data, pid)
            if rec is None:  # lost the race against an external delete
                return None
            rec["used"] = max(0, _as_int(rec.get("used", 0))) + 1
            rec["last_run"] = now_iso()
            # `updated` is deliberately untouched: a run is not an edit, and
            # bumping it would break expect_updated for an open editor.
            self._save_locked(data)
            out = copy.deepcopy(self._by_id[pid])
            self._notify(_EVENT_USED, {"id": pid, "used": out["used"], "rev": self._rev})
            self._emit("usage", [pid], {pid: out})
            return out

    # -- versions ---------------------------------------------------------- #

    def versions(self, pid):
        """Full version entries for a record, oldest first (newest last)."""
        self.ensure_loaded()
        with self._lock:
            rec = self._by_id.get(pid)
            if rec is None:
                raise NotFoundError(f"no prompt with id {pid!r}")
            return copy.deepcopy(rec.get("versions", []))

    def version_previews(self, pid, chars=160):
        """Version metadata + a short preview, never the full bodies.

        A record sitting at the version cap would otherwise be a multi-megabyte
        response on every selection change.
        """
        out = []
        for index, entry in enumerate(self.versions(pid)):
            out.append({
                "index": index,
                "name": entry.get("name", ""),
                "ts": entry.get("ts", ""),
                "src": entry.get("src"),
                "chars": len(entry.get("body", "")),
                "preview": preview_of(entry.get("body", ""), chars),
            })
        return out

    def version(self, pid, index):
        """One full version entry by index. Raises :class:`NotFoundError`."""
        entries = self.versions(pid)
        try:
            index = int(index)
        except (TypeError, ValueError) as exc:
            raise NotFoundError(f"bad version index {index!r}") from exc
        if index < 0 or index >= len(entries):
            raise NotFoundError(f"no version {index} on prompt {pid}")
        return entries[index]

    def restore_version(self, pid, index):
        """Restore a version's body and name onto the record.

        Goes through :meth:`update` with ``snapshot=True``, so the *current*
        body is snapshotted first and the restore is itself undoable. History is
        never erased.
        """
        entry = self.version(pid, index)
        return self.update(pid, name=entry.get("name", ""), body=entry.get("body", ""),
                           snapshot=True)

    # -- merge ------------------------------------------------------------- #

    def merge(self, winner_id, loser_id):
        """Merge ``loser_id`` into ``winner_id`` and delete the loser.

        One lock, one save. Arithmetic: ``used`` summed, tags unioned preserving
        the winner's order, ``rating`` max, ``created`` min, ``last_run`` max,
        notes appended after a ``\\n---\\n`` rule, ``pinned`` OR'd. The loser's
        five most recent versions and then its current body are appended to the
        winner's history, all tagged ``src=<loser id>`` — versions stay
        newest-last, so the loser's live body lands at the end.
        """
        if winner_id == loser_id:
            raise SameRecordError("cannot merge a record into itself")
        with self._lock:
            data = self._begin_write()
            winner = self._require(data, winner_id)
            loser = self._require(data, loser_id)

            for entry in loser.get("versions", [])[-MERGE_VERSIONS_KEPT:]:
                item = dict(entry)
                item["src"] = loser_id
                winner["versions"].append(item)
            winner["versions"].append({
                "body": loser["body"],
                "name": loser["name"],
                "ts": loser.get("updated", "") or now_iso(),
                "src": loser_id,
            })

            _merge_fields(winner, loser)
            winner["updated"] = now_iso()
            _trim_versions(winner, self._version_cap(data))

            data["prompts"] = [r for r in data["prompts"] if r["id"] != loser_id]
            _drop_pairs(data, {loser_id})
            self._register_category(data, winner["category"])

            self._save_locked(data)
            out = copy.deepcopy(self._by_id[winner_id])
            self._emit("merge", [winner_id, loser_id], {winner_id: out, loser_id: None})
            return out

    def merge_new(self, a_id, b_id, body, name):
        """Create a third record absorbing both inputs, then delete both.

        ``body`` and ``name`` are required: a synthesized record has no
        defensible default body, so there is nothing sane to fall back to.
        """
        if a_id == b_id:
            raise SameRecordError("cannot merge a record with itself")
        if not _as_str(name).strip():
            raise ValueError("merge_new requires a name")
        if not _as_str(body).strip():
            raise ValueError("merge_new requires a body")
        with self._lock:
            data = self._begin_write()
            first = self._require(data, a_id)
            second = self._require(data, b_id)

            stamp = now_iso()
            rec = _clean_record({
                "id": new_id(),
                "name": name,
                "body": body,
                "category": first["category"] or second["category"],
                "tags": list(first["tags"]),
                "rating": first["rating"],
                "used": first["used"],
                "last_run": first["last_run"],
                "created": first["created"],
                "updated": stamp,
                "notes": first["notes"],
                "pinned": first["pinned"],
                "versions": [],
            })
            for source in (first, second):
                for entry in source.get("versions", [])[-MERGE_VERSIONS_KEPT:]:
                    item = dict(entry)
                    item["src"] = source["id"]
                    rec["versions"].append(item)
                rec["versions"].append({
                    "body": source["body"],
                    "name": source["name"],
                    "ts": source.get("updated", "") or stamp,
                    "src": source["id"],
                })
            _merge_fields(rec, second)
            rec["updated"] = stamp
            _trim_versions(rec, self._version_cap(data))

            data["prompts"] = [r for r in data["prompts"] if r["id"] not in (a_id, b_id)]
            data["prompts"].append(rec)
            _drop_pairs(data, {a_id, b_id})
            self._register_category(data, rec["category"])

            self._save_locked(data)
            out = copy.deepcopy(self._by_id[rec["id"]])
            self._emit("merge_new", [rec["id"], a_id, b_id],
                       {rec["id"]: out, a_id: None, b_id: None})
            return out

    # -- taxonomy ---------------------------------------------------------- #

    def categories(self):
        """Sorted category names: the stored list unioned with what records use.

        The union is what makes a hand-edited file self-heal, and the stored half
        is what lets an empty category exist.
        """
        self.ensure_loaded()
        with self._lock:
            names = set(self._data.get("categories", []))
            for rec in self._data.get("prompts", []):
                if rec.get("category"):
                    names.add(rec["category"])
            return sorted(names)

    def tags(self):
        """Derived tag counts as ``[{"tag": t, "count": n}, ...]``, most used first."""
        self.ensure_loaded()
        with self._lock:
            counts = {}
            for rec in self._data.get("prompts", []):
                for tag in rec.get("tags", []):
                    counts[tag] = counts.get(tag, 0) + 1
        return [{"tag": tag, "count": count}
                for tag, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    def taxonomy(self):
        """Everything the filter rail needs: categories (with counts) and tags."""
        self.ensure_loaded()
        with self._lock:
            counts = {}
            for rec in self._data.get("prompts", []):
                key = rec.get("category", "")
                counts[key] = counts.get(key, 0) + 1
            total = len(self._data.get("prompts", []))
        return {
            "categories": [{"name": name, "count": counts.get(name, 0)}
                           for name in self.categories()],
            "tags": self.tags(),
            "total": total,
        }

    def _register_category(self, data, name):
        """Remember a category so it survives its last record being deleted."""
        if name and name not in data.setdefault("categories", []):
            data["categories"].append(name)

    def add_category(self, name):
        """Create an (possibly empty) category. Returns the sorted category list."""
        target = clean_category(name)
        if not target:
            raise ValueError("category name is empty")
        with self._lock:
            data = self._begin_write()
            if target in data.get("categories", []):
                return self.categories()
            self._register_category(data, target)
            self._save_locked(data)
            self._emit("category", [], {})
            return self.categories()

    def rename_category(self, old, new):
        """Rename a category and move every record in it. Returns the count moved."""
        source = clean_category(old)
        target = clean_category(new)
        if not source or not target:
            raise ValueError("category names cannot be empty")
        if source == target:
            return 0
        with self._lock:
            data = self._begin_write()
            data["categories"] = [c for c in data.get("categories", []) if c != source]
            self._register_category(data, target)
            touched = []
            for rec in data["prompts"]:
                if rec.get("category") == source:
                    rec["category"] = target
                    rec["updated"] = now_iso()
                    touched.append(rec["id"])
            self._save_locked(data)
            self._emit("category", touched,
                       {pid: copy.deepcopy(self._by_id[pid]) for pid in touched})
            return len(touched)

    def delete_category(self, name, reassign_to=""):
        """Forget a category; its records move to ``reassign_to`` (default none).

        Records are never deleted along with a category — losing prompts to a
        taxonomy edit would be indefensible.
        """
        source = clean_category(name)
        target = clean_category(reassign_to)
        if not source:
            raise ValueError("category name is empty")
        with self._lock:
            data = self._begin_write()
            data["categories"] = [c for c in data.get("categories", []) if c != source]
            if target:
                self._register_category(data, target)
            touched = []
            for rec in data["prompts"]:
                if rec.get("category") == source:
                    rec["category"] = target
                    rec["updated"] = now_iso()
                    touched.append(rec["id"])
            self._save_locked(data)
            self._emit("category", touched,
                       {pid: copy.deepcopy(self._by_id[pid]) for pid in touched})
            return len(touched)

    # -- snippets ---------------------------------------------------------- #

    def snippets(self):
        """Return a copy of ``{name: {"body": ..., "updated": ...}}``."""
        self.ensure_loaded()
        with self._lock:
            return copy.deepcopy(self._data.get("snippets", {}))

    def get_snippet(self, name):
        """Return one snippet's body, or ``None`` when it does not exist."""
        key = _as_str(name).strip()
        self.ensure_loaded()
        with self._lock:
            entry = self._data.get("snippets", {}).get(key)
            return entry.get("body", "") if isinstance(entry, dict) else None

    def set_snippet(self, name, body):
        """Create or replace a snippet. Returns the stored entry."""
        key = _as_str(name).strip()[:MAX_SNIPPET_NAME_CHARS]
        if not key:
            raise ValueError("snippet name is empty")
        text = clean_body(body)
        with self._lock:
            data = self._begin_write()
            entry = {"body": text, "updated": now_iso()}
            data.setdefault("snippets", {})[key] = entry
            self._save_locked(data)
            self._emit("snippet", [], {})
            return dict(entry)

    def delete_snippet(self, name):
        """Delete a snippet. Raises :class:`NotFoundError` when it does not exist."""
        key = _as_str(name).strip()
        with self._lock:
            data = self._begin_write()
            if key not in data.get("snippets", {}):
                raise NotFoundError(f"no snippet named {key!r}")
            del data["snippets"][key]
            self._save_locked(data)
            self._emit("snippet", [], {})
            return True

    # -- ignored dupe pairs ------------------------------------------------- #

    def ignore_pair(self, a, b):
        """Record a "keep both" decision so dedupe stops reporting the pair.

        Pairs are stored sorted, so the call is order-independent.
        """
        first, second = _as_str(a), _as_str(b)
        if not first or not second or first == second:
            raise ValueError("ignore_pair needs two distinct ids")
        key = sorted((first, second))
        with self._lock:
            data = self._begin_write()
            for pair in data.get("ignored", []):
                if list(pair) == key:
                    return False
            data.setdefault("ignored", []).append(key)
            self._save_locked(data)
            self._emit("ignore", [first, second], {})
            return True

    def unignore_pair(self, a, b):
        """Forget a "keep both" decision so the pair is reported again."""
        key = sorted((_as_str(a), _as_str(b)))
        with self._lock:
            data = self._begin_write()
            before = len(data.get("ignored", []))
            data["ignored"] = [p for p in data.get("ignored", []) if list(p) != key]
            if len(data["ignored"]) == before:
                return False
            self._save_locked(data)
            self._emit("ignore", [key[0], key[1]], {})
            return True

    def is_ignored(self, a, b):
        """True when the user chose "keep both" for this (unordered) pair."""
        key = sorted((_as_str(a), _as_str(b)))
        self.ensure_loaded()
        with self._lock:
            return any(list(pair) == key for pair in self._data.get("ignored", []))

    def ignored_pairs(self):
        """All ignored pairs as a set of ``(lo, hi)`` tuples (O(1) membership)."""
        self.ensure_loaded()
        with self._lock:
            return {(p[0], p[1]) for p in self._data.get("ignored", []) if len(p) == 2}

    # -- import / export --------------------------------------------------- #

    def export_raw(self):
        """A deep copy of the whole envelope, ready to hand to ``json.dumps``."""
        self.ensure_loaded()
        with self._lock:
            return copy.deepcopy(self._data)

    def import_raw(self, raw, replace=True):
        """Import an envelope (coerced first, so any junk is survivable).

        ``replace=True`` swaps the library wholesale. ``replace=False`` appends:
        records whose id already exists are given a fresh id rather than
        clobbering the resident record, and categories/snippets/ignored pairs are
        unioned. Returns the number of records imported.
        """
        incoming = _coerce(raw)
        with self._lock:
            data = self._begin_write()
            if replace:
                data["categories"] = incoming["categories"]
                data["snippets"] = incoming["snippets"]
                data["ignored"] = incoming["ignored"]
                data["prompts"] = incoming["prompts"]
                data["settings"] = incoming["settings"]
                added = len(incoming["prompts"])
            else:
                existing = {r["id"] for r in data["prompts"]}
                for rec in incoming["prompts"]:
                    if rec["id"] in existing:
                        rec["id"] = new_id()
                    existing.add(rec["id"])
                    data["prompts"].append(rec)
                    self._register_category(data, rec["category"])
                for name in incoming["categories"]:
                    self._register_category(data, name)
                for name, entry in incoming["snippets"].items():
                    data.setdefault("snippets", {}).setdefault(name, entry)
                have = {tuple(p) for p in data.get("ignored", [])}
                for pair in incoming["ignored"]:
                    if tuple(pair) not in have:
                        data["ignored"].append(pair)
                added = len(incoming["prompts"])
            self._save_locked(data)
            self._emit("import", [], {})
            return added


# --------------------------------------------------------------------------- #
# Module-level helpers used by the store
# --------------------------------------------------------------------------- #

def _silent_unlink(path):
    with contextlib.suppress(OSError):
        os.unlink(path)


def _drop_pairs(data, ids):
    """Remove every ignored pair that mentions one of ``ids`` (they are gone)."""
    data["ignored"] = [p for p in data.get("ignored", [])
                       if len(p) == 2 and p[0] not in ids and p[1] not in ids]


def _trim_versions(rec, cap=VERSION_CAP, bytes_cap=VERSION_BYTES_CAP):
    """Drop the oldest versions until both the count and the byte caps hold.

    Both caps are needed: 50 versions of a 100 KB body would be a 5 MB record,
    and a byte cap alone would let thousands of one-line versions accumulate.
    At least one version is always kept, so a snapshot that is on its own bigger
    than the byte cap still leaves history behind rather than erasing it.
    """
    versions = rec.get("versions")
    if not isinstance(versions, list):
        rec["versions"] = []
        return
    while len(versions) > cap:
        versions.pop(0)
    total = sum(len(v.get("body", "").encode("utf-8")) for v in versions)
    while len(versions) > 1 and total > bytes_cap:
        total -= len(versions[0].get("body", "").encode("utf-8"))
        versions.pop(0)


def _merge_fields(winner, loser):
    """Apply the merge arithmetic of ``loser`` onto ``winner`` in place."""
    winner["used"] = max(0, _as_int(winner.get("used", 0))) + max(0, _as_int(loser.get("used", 0)))
    tags = list(winner.get("tags", []))
    for tag in loser.get("tags", []):
        if tag not in tags:
            tags.append(tag)
    winner["tags"] = clean_tags(tags)
    winner["rating"] = max(_as_int(winner.get("rating", 0)), _as_int(loser.get("rating", 0)))
    # ISO-8601 Z strings sort lexicographically, so min/max need no parsing.
    winner["created"] = _min_ts(winner.get("created", ""), loser.get("created", ""))
    winner["last_run"] = _max_ts(winner.get("last_run", ""), loser.get("last_run", ""))
    winner["pinned"] = bool(winner.get("pinned")) or bool(loser.get("pinned"))
    if not winner.get("category"):
        winner["category"] = loser.get("category", "")
    mine, theirs = _as_str(winner.get("notes", "")), _as_str(loser.get("notes", ""))
    if theirs.strip():
        winner["notes"] = (mine + "\n---\n" + theirs) if mine.strip() else theirs


def _min_ts(a, b):
    if not a:
        return b or ""
    if not b:
        return a
    return a if a <= b else b


def _max_ts(a, b):
    if not a:
        return b or ""
    if not b:
        return a
    return a if a >= b else b


# The process-wide store. The class exists so tests (and any future multi-library
# feature) can point at another path; the singleton gives module-level ergonomics
# to the api layer.
STORE = LibrarianStore()
