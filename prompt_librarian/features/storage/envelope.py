"""The portable JSON envelope: metadata plus every record, as exports write it.

Malformed input is tolerated and unknown keys survive, for forward compatibility.
"""

from typing import Any

from ...shared.clock import new_id, now_iso
from ...shared.coerce import as_int, as_str
from ...shared.db.schema import SCHEMA_VERSION
from ...shared.meta import DEFAULT_DUPE_THRESHOLD, clean_pairs, clean_settings, clean_snippets
from ...shared.records import VERSION_CAP, Record, coerce_record

Envelope = dict[str, Any]

#: Envelope keys an export writes before ``prompts``, in order.
META_KEYS = ("schema", "updated", "settings", "snippets", "ignored")


def empty_envelope() -> Envelope:
    """A fresh, valid, empty library envelope."""
    return {
        "schema": SCHEMA_VERSION,
        "updated": now_iso(),
        "settings": {"dupe_threshold": DEFAULT_DUPE_THRESHOLD, "version_cap": VERSION_CAP},
        "snippets": {},
        "ignored": [],
        "prompts": [],
    }


def coerce_envelope(raw: object) -> Envelope:
    """Any input as a valid envelope; duplicated record ids get fresh ones."""
    if not isinstance(raw, dict):
        return empty_envelope()
    out = dict(raw)
    out.pop("categories", None)
    out["schema"] = as_int(raw.get("schema", SCHEMA_VERSION), SCHEMA_VERSION)
    out["updated"] = as_str(raw.get("updated", "")) or now_iso()
    out["settings"] = clean_settings(raw.get("settings"))
    out["snippets"] = clean_snippets(raw.get("snippets"))
    out["ignored"] = clean_pairs(raw.get("ignored"))
    out["prompts"] = _coerce_prompts(raw.get("prompts"))
    return out


def _coerce_prompts(raw: object) -> list[Record]:
    prompts: list[Record] = []
    seen: set[str] = set()
    for entry in raw if isinstance(raw, (list, tuple)) else ():
        rec = coerce_record(entry)
        if rec is None:
            continue
        if rec["id"] in seen:  # a duplicated id would shadow a record
            rec["id"] = new_id()
        seen.add(rec["id"])
        prompts.append(rec)
    return prompts


def envelope_from_parts(
    settings: object,
    snippets: object,
    ignored: object,
    prompts: list[Record],
    updated: str = "",
    schema: object = SCHEMA_VERSION,
) -> Envelope:
    """Assemble stored metadata and records into the portable envelope."""
    return {
        "schema": as_int(schema, SCHEMA_VERSION),
        "updated": as_str(updated) or now_iso(),
        "settings": clean_settings(settings),
        "snippets": clean_snippets(snippets),
        "ignored": clean_pairs(ignored),
        "prompts": list(prompts),
    }
