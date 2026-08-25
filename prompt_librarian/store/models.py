"""Record/envelope shapes and SQLite projection helpers.

The data model lives here, deliberately apart from any storage. A *record* is a
plain dict::

    {"id": "9f2c...", "body": "...", "tags": [...], "rating": 0, "used": 0,
     "last_run": "", "created": "...", "updated": "...", "notes": "",
     "pinned": False, "versions": [{"body": "...", "ts": "...", "src": None}]}

and an *envelope* is the whole library around them (schema, settings, snippets,
ignored pairs, prompts). JSON and JSONL imports are coerced into these shapes
before they enter SQLite.

Two coercion levels, and the difference matters:

* :func:`_clean_record` **validates** — it raises
  :class:`~.types.BodyTooLargeError`. Use it on the way *in*, before a mutation
  touches the live library, so a rejected edit cannot half-apply.
* :func:`_coerce_record` **tolerates** — it never raises. Use it on the way
  *out* of storage: a hand-edited file must load, and refusing to show the user
  their own data would be worse than holding an oversized body in memory. The
  next *edit* still has to pass the limit.

The projection helper keeps browse/search metadata separate from full records.
"""

from .types import (
    DEFAULT_DUPE_THRESHOLD,
    MAX_SNIPPET_NAME_CHARS,
    REMOVED_FIELDS,
    SCHEMA_VERSION,
    VERSION_BYTES_CAP,
    VERSION_CAP,
)
from .utils import (
    _as_int,
    _as_str,
    _clamp,
    _max_ts,
    _min_ts,
    clean_body,
    clean_tags,
    new_id,
    now_iso,
    preview_of,
)

OP_PUT = "put"
OP_DEL = "del"
_LEGACY_LINE_KEYS = ("_seq", "_op", "_ts")


# --------------------------------------------------------------------------- #
# Records
# --------------------------------------------------------------------------- #

def _clean_record(rec):
    """Return a normalized copy of a record dict, preserving unknown keys.

    Raises :class:`~.types.BodyTooLargeError` for an oversized body. Called
    *before* any mutation of the live library so a rejected edit cannot
    half-apply.
    """
    out = dict(rec)
    for gone in REMOVED_FIELDS:        # removed fields: scrubbed, never rewritten
        out.pop(gone, None)
    out["id"] = _as_str(rec.get("id")) or new_id()
    out["body"] = clean_body(rec.get("body", ""))
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
        item.pop("name", None)         # removed field: scrubbed, never rewritten
        item["body"] = _as_str(entry.get("body", ""))
        item["ts"] = _as_str(entry.get("ts", ""))
        src = entry.get("src")
        item["src"] = _as_str(src) if isinstance(src, str) and src else None
        out.append(item)
    return out


def _coerce_record(raw):
    """Tolerant coercion of one stored record. Never raises.

    Unlike :func:`_clean_record` this accepts an oversized body — see the module
    docstring for why.
    """
    if not isinstance(raw, dict):
        return None
    out = dict(raw)
    for gone in REMOVED_FIELDS:        # removed fields: scrubbed, never rewritten
        out.pop(gone, None)
    for gone in _LEGACY_LINE_KEYS:     # legacy JSONL bookkeeping is not record data
        out.pop(gone, None)
    out["id"] = _as_str(raw.get("id")) or new_id()
    out["body"] = _as_str(raw.get("body", ""))
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


# --------------------------------------------------------------------------- #
# Envelope
# --------------------------------------------------------------------------- #

def empty_envelope():
    """A fresh, valid, empty library envelope."""
    return {
        "schema": SCHEMA_VERSION,
        "updated": now_iso(),
        "settings": {
            "dupe_threshold": DEFAULT_DUPE_THRESHOLD,
            "version_cap": VERSION_CAP,
        },
        "snippets": {},
        "ignored": [],
        "prompts": [],
    }


def clean_settings(raw):
    """Coerce a settings block: both keys present, both in range. Never raises."""
    merged = dict(raw) if isinstance(raw, dict) else {}
    threshold = merged.get("dupe_threshold", DEFAULT_DUPE_THRESHOLD)
    try:
        threshold = float(threshold)
    except (TypeError, ValueError):
        threshold = DEFAULT_DUPE_THRESHOLD
    merged["dupe_threshold"] = _clamp(threshold, 0.0, 1.0)
    merged["version_cap"] = _clamp(
        _as_int(merged.get("version_cap", VERSION_CAP), VERSION_CAP), 1, 1000
    )
    return merged


def clean_snippets(raw):
    """Coerce a ``{name: entry}`` snippet map. Accepts bare strings as bodies."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for key, value in raw.items():
        name = _as_str(key).strip()[:MAX_SNIPPET_NAME_CHARS]
        if not name:
            continue
        if isinstance(value, str):
            out[name] = {"body": value, "updated": now_iso()}
        elif isinstance(value, dict):
            item = dict(value)
            item["body"] = _as_str(value.get("body", ""))
            item["updated"] = _as_str(value.get("updated", "")) or now_iso()
            out[name] = item
    return out


def clean_pairs(raw):
    """Coerce an ``ignored`` list into sorted, deduped, self-free ``[lo, hi]`` pairs."""
    out = []
    seen = set()
    if not isinstance(raw, (list, tuple)):
        return out
    for pair in raw:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        a, b = _as_str(pair[0]), _as_str(pair[1])
        if not a or not b or a == b:
            continue
        key = tuple(sorted((a, b)))
        if key in seen:
            continue
        seen.add(key)
        out.append([key[0], key[1]])
    return out


def _coerce(raw):
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
    out.pop("categories", None)        # removed field: scrubbed, never rewritten

    out["schema"] = _as_int(raw.get("schema", SCHEMA_VERSION), SCHEMA_VERSION)
    out["updated"] = _as_str(raw.get("updated", "")) or now_iso()
    out["settings"] = clean_settings(raw.get("settings"))
    out["snippets"] = clean_snippets(raw.get("snippets"))
    out["ignored"] = clean_pairs(raw.get("ignored"))

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


def envelope_from_parts(settings, snippets, ignored, prompts, updated="", schema=SCHEMA_VERSION):
    """Assemble SQLite rows and metadata into the portable JSON envelope."""
    return {
        "schema": _as_int(schema, SCHEMA_VERSION),
        "updated": _as_str(updated) or now_iso(),
        "settings": clean_settings(settings),
        "snippets": clean_snippets(snippets),
        "ignored": clean_pairs(ignored),
        "prompts": list(prompts),
    }


# --------------------------------------------------------------------------- #
# SQLite browse/search projection
# --------------------------------------------------------------------------- #
def index_entry(rec):
    """The lightweight metadata SQLite exposes for listing and sorting.
    """
    return {
        "tags": list(rec.get("tags", [])),
        "rating": _as_int(rec.get("rating", 0)),
        "used": _as_int(rec.get("used", 0)),
        "pinned": bool(rec.get("pinned")),
        "created": _as_str(rec.get("created", "")),
        "updated": _as_str(rec.get("updated", "")),
        "last_run": _as_str(rec.get("last_run", "")),
        "chars": len(_as_str(rec.get("body", ""))),
        "versions": len(rec.get("versions", []) or ()),
        "preview": preview_of(rec.get("body", "")),
    }


# --------------------------------------------------------------------------- #
# Mutation arithmetic
# --------------------------------------------------------------------------- #

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
    mine, theirs = _as_str(winner.get("notes", "")), _as_str(loser.get("notes", ""))
    if theirs.strip():
        winner["notes"] = (mine + "\n---\n" + theirs) if mine.strip() else theirs
