"""Writing many records at once, for imports and legacy migration."""

from collections.abc import Callable

from ...shared import entries
from ...shared.db import schema
from ...shared.library import Library
from ...shared.records import Record

#: Receives the stored envelope (``None`` if unset) and returns the one to store.
EditMeta = Callable[[dict | None], dict]


def put_prompts(lib: Library, records: list[Record], edit_meta: EditMeta | None = None) -> None:
    """Add or overwrite ``records``, and optionally edit the envelope, in one transaction."""
    with lib.write("import") as work:
        for rec in records:
            entries.put(work, rec)
        if edit_meta is not None:
            schema.write_meta(work.con, edit_meta(schema.read_meta(work.con)))


def replace_prompts(lib: Library, records: list[Record], edit_meta: EditMeta) -> None:
    """Replace every record and the envelope in one transaction; order is kept."""
    with lib.write("import") as work:
        meta = edit_meta(schema.read_meta(work.con))
        entries.clear(work)
        for rec in records:
            entries.put(work, rec)
        schema.write_meta(work.con, meta)

