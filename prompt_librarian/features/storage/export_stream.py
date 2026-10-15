"""Exporting the library as a byte stream: never every prompt body at once."""

import json

from ...shared import entries
from ...shared.library import Library
from .export import export_metadata

#: Records serialized per executor hop while streaming.
EXPORT_BATCH = 32

#: Closes the ``prompts`` array and the envelope opened by :func:`export_head`.
EXPORT_TAIL = b"]}"

_HEAD_KEYS = ("schema", "updated", "settings", "snippets", "ignored")


def _json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def export_head(lib: Library) -> tuple[bytes, list[str]]:
    """The envelope up to an open ``"prompts":[``, and every record id in order."""
    meta = export_metadata(lib)
    ids: list[str] = []
    if lib.exists():
        with lib.read() as con:
            ids = entries.ids(con)
    fields = ",".join(f"{_json_text(key)}:{_json_text(meta[key])}" for key in _HEAD_KEYS)
    return ("{" + fields + ',"prompts":[').encode("utf-8"), ids


def export_records(lib: Library, ids: list[str]) -> list[bytes]:
    """One batch of records as JSON, in ``ids`` order, skipping ids gone since the head."""
    if not ids or not lib.exists():
        return []
    with lib.read() as con:
        records = entries.get_many(con, ids)
    return [_json_text(rec).encode("utf-8") for rec in records]
