"""Read-only import support for legacy JSON and JSONL libraries."""

import json
import os

from ...shared.coerce import as_int as _as_int
from ...shared.coerce import as_str as _as_str
from ...shared.db.schema import SCHEMA_VERSION
from ...shared.errors import StoreWriteError
from ...shared.records import Record
from ...shared.records import coerce_record as _coerce_record
from .envelope import Envelope, envelope_from_parts
from .envelope import coerce_envelope as _coerce

_OP_KEY = "_op"
_SEQ_KEY = "_seq"
_PUT = "put"
_DELETE = "del"
_META = "meta"

#: ``(operation, sequence, prompt id, payload)`` for one decoded log line.
Event = tuple[str, int, str, dict | None]


def same_record(first: Record, second: Record) -> bool:
    """Content equality tolerant of timestamps synthesized for old files."""
    ignored = {"id", "created", "updated"}
    return {key: value for key, value in first.items() if key not in ignored} == {
        key: value for key, value in second.items() if key not in ignored
    }


def _decode_jsonl_line(text: str) -> Event | None:
    """Decode one historical log event, or return ``None`` when unusable."""
    try:
        raw = json.loads(text)
    except (TypeError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    operation = _as_str(raw.get(_OP_KEY)) or _PUT
    sequence = _as_int(raw.get(_SEQ_KEY), 0)
    if operation == _META:
        state = raw.get("state")
        return operation, sequence, "", dict(state) if isinstance(state, dict) else {}
    prompt_id = _as_str(raw.get("id"))
    if not prompt_id:
        return None
    if operation == _DELETE:
        return operation, sequence, prompt_id, None
    return _PUT, sequence, prompt_id, _coerce_record(raw)


def _replay(event: Event, records: dict[str, Record], order: list[str], meta: dict) -> list[str]:
    """Apply one log event to the state being rebuilt; returns the new id order."""
    operation, _sequence, prompt_id, payload = event
    if operation == _META:
        meta.update(payload if isinstance(payload, dict) else {})
    elif operation == _DELETE:
        records.pop(prompt_id, None)
        return [current for current in order if current != prompt_id]
    elif payload is not None:
        if prompt_id not in records:
            order.append(prompt_id)
        records[prompt_id] = payload
    return order


def _read_jsonl(source: str) -> tuple[Envelope, int]:
    records: dict[str, Record] = {}
    order: list[str] = []
    meta = _coerce({})
    skipped = 0
    try:
        with open(source, encoding="utf-8") as handle:
            for line in handle:
                parsed = _decode_jsonl_line(line)
                if parsed is None:
                    skipped += bool(line.strip())
                    continue
                order = _replay(parsed, records, order, meta)
    except OSError as exc:
        raise StoreWriteError(f"cannot read {source}: {exc}") from exc

    return envelope_from_parts(
        settings=meta.get("settings"),
        snippets=meta.get("snippets"),
        ignored=meta.get("ignored"),
        prompts=[records[prompt_id] for prompt_id in order if prompt_id in records],
        updated=meta.get("updated", ""),
        schema=meta.get("schema", SCHEMA_VERSION),
    ), skipped


def _read_json(source: str) -> tuple[Envelope, int]:
    try:
        with open(source, encoding="utf-8") as handle:
            raw = json.load(handle)
    except OSError as exc:
        raise StoreWriteError(f"cannot read {source}: {exc}") from exc
    except ValueError as exc:
        raise ValueError(f"legacy library at {source} is not valid JSON") from exc
    return _coerce(raw), 0


def read_legacy(source: str | os.PathLike) -> tuple[Envelope, int]:
    """Return ``(envelope, skipped_lines)`` without modifying ``source``."""
    source = os.fspath(source)
    if source.lower().endswith((".jsonl", ".ndjson")):
        return _read_jsonl(source)
    return _read_json(source)
