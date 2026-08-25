"""Read-only import support for legacy JSON and JSONL libraries."""

import json
import os

from .models import _coerce, _coerce_record, envelope_from_parts
from .types import SCHEMA_VERSION, StoreWriteError
from .utils import _as_int, _as_str

_OP_KEY = "_op"
_SEQ_KEY = "_seq"
_PUT = "put"
_DELETE = "del"
_META = "meta"


def same_record(first, second):
    """Content equality tolerant of timestamps synthesized for old files."""
    ignored = {"id", "created", "updated"}
    return {key: value for key, value in first.items() if key not in ignored} == {
        key: value for key, value in second.items() if key not in ignored
    }


def _decode_jsonl_line(text):
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


def _read_jsonl(source):
    records = {}
    order = []
    meta = _coerce({})
    skipped = 0
    try:
        with open(source, encoding="utf-8") as handle:
            for line in handle:
                parsed = _decode_jsonl_line(line)
                if parsed is None:
                    if line.strip():
                        skipped += 1
                    continue
                operation, _sequence, prompt_id, payload = parsed
                if operation == _META:
                    meta.update(payload if isinstance(payload, dict) else {})
                elif operation == _DELETE:
                    records.pop(prompt_id, None)
                    order = [current for current in order if current != prompt_id]
                elif payload is not None:
                    if prompt_id not in records:
                        order.append(prompt_id)
                    records[prompt_id] = payload
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


def _read_json(source):
    try:
        with open(source, encoding="utf-8") as handle:
            raw = json.load(handle)
    except OSError as exc:
        raise StoreWriteError(f"cannot read {source}: {exc}") from exc
    except ValueError as exc:
        raise ValueError(f"legacy library at {source} is not valid JSON") from exc
    return _coerce(raw), 0


def read_legacy(source):
    """Return ``(envelope, skipped_lines)`` without modifying ``source``."""
    source = os.fspath(source)
    if source.lower().endswith((".jsonl", ".ndjson")):
        return _read_jsonl(source)
    return _read_json(source)
