"""The prompt record: its shape, validation, version history and merge arithmetic.

Incoming edits go through :func:`clean_record`, which validates and may raise.
Stored data goes through :func:`coerce_record`, which tolerates oversized bodies
so existing records stay readable; their next edit must pass validation.
"""

import re
from typing import Any

from .clock import new_id, now_iso
from .coerce import as_int, as_str, clamp
from .errors import BodyTooLargeError
from .text import preview_of

MAX_BODY_CHARS = 100000
MAX_TAG_CHARS = 40
MAX_TAGS = 32

VERSION_CAP = 50
VERSION_BYTES_CAP = 262144  # 256 KB of version bodies per record
MERGE_VERSIONS_KEPT = 5  # of the loser's own history, on merge

#: Fields this build no longer keeps. They are scrubbed from imported and loaded
#: records without a schema bump because they were never required for identity.
REMOVED_FIELDS = ("category", "name")
#: Legacy JSONL bookkeeping, which is not record data.
_LEGACY_LINE_KEYS = ("_seq", "_op", "_ts")
_WS_RE = re.compile(r"\s+", re.UNICODE)

Record = dict[str, Any]


def clean_tag(tag: object) -> str:
    """Casefold tags consistently with queries, including expansions such as ß."""
    return _WS_RE.sub("-", as_str(tag).strip()).casefold()[:MAX_TAG_CHARS]


def clean_tags(tags: object) -> list[str]:
    """Normalize a tag list: cleaned, empties dropped, deduped in order, capped."""
    if isinstance(tags, str):
        tags = re.split(r"[,\n]", tags)
    if not isinstance(tags, (list, tuple, set, frozenset)):
        return []
    out: list[str] = []
    for raw in tags:
        tag = clean_tag(raw)
        if tag and tag not in out:
            out.append(tag)
        if len(out) >= MAX_TAGS:
            break
    return out


def clean_body(body: object) -> str:
    """Validate a body. Raises :class:`BodyTooLargeError`; never truncates."""
    text = as_str(body)
    if len(text) > MAX_BODY_CHARS:
        raise BodyTooLargeError(f"body is {len(text)} characters, the limit is {MAX_BODY_CHARS}")
    return text


def coerce_versions(raw: object) -> list[dict[str, Any]]:
    """Tolerant coercion of a ``versions`` list; drops entries that make no sense."""
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        item = dict(entry)
        item.pop("name", None)
        item["body"] = as_str(entry.get("body", ""))
        item["ts"] = as_str(entry.get("ts", ""))
        src = entry.get("src")
        item["src"] = as_str(src) if isinstance(src, str) and src else None
        out.append(item)
    return out


def _fill(out: Record, raw: dict[str, Any], body: str) -> Record:
    """Coerce every known field onto ``out``; unknown keys stay as they are."""
    for gone in REMOVED_FIELDS:
        out.pop(gone, None)
    out["id"] = as_str(raw.get("id")) or new_id()
    out["body"] = body
    out["tags"] = clean_tags(raw.get("tags", []))
    out["rating"] = clamp(as_int(raw.get("rating", 0)), 0, 5)
    out["used"] = max(0, as_int(raw.get("used", 0)))
    out["notes"] = as_str(raw.get("notes", ""))
    out["pinned"] = bool(raw.get("pinned", False))
    out["last_run"] = as_str(raw.get("last_run", ""))
    out["created"] = as_str(raw.get("created", "")) or now_iso()
    out["updated"] = as_str(raw.get("updated", "")) or out["created"]
    out["versions"] = coerce_versions(raw.get("versions", []))
    return out


def clean_record(rec: dict[str, Any]) -> Record:
    """Validate before mutation; raise BodyTooLargeError and keep unknown keys."""
    return _fill(dict(rec), rec, clean_body(rec.get("body", "")))


def coerce_record(raw: object) -> Record | None:
    """Stored data, tolerantly: oversized bodies stay readable. ``None`` for non-dicts."""
    if not isinstance(raw, dict):
        return None
    out = dict(raw)
    for gone in _LEGACY_LINE_KEYS:
        out.pop(gone, None)
    return _fill(out, raw, as_str(raw.get("body", "")))


def index_entry(rec: Record) -> dict[str, Any]:
    """The lightweight metadata stored beside a record for listing and sorting."""
    body = as_str(rec.get("body", ""))
    return {
        "tags": list(rec.get("tags", [])),
        "rating": as_int(rec.get("rating", 0)),
        "used": as_int(rec.get("used", 0)),
        "pinned": bool(rec.get("pinned")),
        "created": as_str(rec.get("created", "")),
        "updated": as_str(rec.get("updated", "")),
        "last_run": as_str(rec.get("last_run", "")),
        "chars": len(body),
        "versions": len(rec.get("versions", []) or ()),
        "preview": preview_of(body),
    }


def trim_versions(rec: Record, cap: int = VERSION_CAP, bytes_cap: int = VERSION_BYTES_CAP) -> None:
    """Enforce count and byte caps, keeping at least one snapshot even if oversized."""
    versions = rec.get("versions")
    if not isinstance(versions, list):
        rec["versions"] = []
        return
    del versions[: max(0, len(versions) - cap)]
    total = sum(len(v.get("body", "").encode("utf-8")) for v in versions)
    while len(versions) > 1 and total > bytes_cap:
        total -= len(versions.pop(0).get("body", "").encode("utf-8"))


def min_ts(a: str, b: str) -> str:
    """Earlier of two ISO-8601 ``Z`` stamps; ``""`` counts as absent."""
    if not a or not b:
        return a or b or ""
    return min(a, b)


def max_ts(a: str, b: str) -> str:
    """Later of two ISO-8601 ``Z`` stamps; ``""`` counts as absent."""
    if not a or not b:
        return a or b or ""
    return max(a, b)


def merge_fields(winner: Record, loser: Record) -> None:
    """Apply ``loser``'s merge arithmetic onto ``winner`` in place.

    ``used`` summed, tags unioned in the winner's order, ``rating`` max,
    ``created`` min, ``last_run`` max, ``pinned`` OR'd, notes appended after a
    ``---`` rule.
    """
    winner["used"] = max(0, as_int(winner.get("used", 0))) + max(0, as_int(loser.get("used", 0)))
    tags = list(winner.get("tags", []))
    tags += [tag for tag in loser.get("tags", []) if tag not in tags]
    winner["tags"] = clean_tags(tags)
    winner["rating"] = max(as_int(winner.get("rating", 0)), as_int(loser.get("rating", 0)))
    # ISO-8601 Z strings sort lexicographically, so min/max need no parsing.
    winner["created"] = min_ts(winner.get("created", ""), loser.get("created", ""))
    winner["last_run"] = max_ts(winner.get("last_run", ""), loser.get("last_run", ""))
    winner["pinned"] = bool(winner.get("pinned")) or bool(loser.get("pinned"))
    mine, theirs = as_str(winner.get("notes", "")), as_str(loser.get("notes", ""))
    if theirs.strip():
        winner["notes"] = (mine + "\n---\n" + theirs) if mine.strip() else theirs
