"""Importing a portable envelope: replacing the library, or merging into it."""

import json

from ...shared import entries
from ...shared.clock import new_id, now_iso
from ...shared.library import Library
from ...shared.meta import Meta, clean_meta
from .envelope import Envelope, coerce_envelope
from .records import put_prompts, replace_prompts


def import_library(lib: Library, raw: object, replace: bool = True) -> int:
    """Import ``raw`` (coerced first, so junk is survivable); returns the record count."""
    incoming = coerce_envelope(raw)
    if replace:
        replace_prompts(lib, incoming["prompts"], lambda stored: _replaced(stored, incoming))
        return len(incoming["prompts"])
    existing = set()
    if lib.exists():
        with lib.read() as con:
            existing = set(entries.ids(con))
    for rec in incoming["prompts"]:
        if rec["id"] in existing:
            rec["id"] = new_id()
    put_prompts(lib, incoming["prompts"], lambda stored: _merged(stored, incoming))
    return len(incoming["prompts"])



def import_library_file(lib: Library, path: str, replace: bool = False) -> int:
    """Import the JSON envelope stored at ``path``; see :func:`import_library`."""
    with open(path, encoding="utf-8") as handle:
        raw = json.load(handle)
    return import_library(lib, raw, replace)

def _replaced(stored: object, incoming: Envelope) -> Meta:
    meta = clean_meta(stored)
    meta.update(
        settings=incoming["settings"],
        snippets=incoming["snippets"],
        ignored=incoming["ignored"],
        updated=now_iso(),
    )
    return meta


def _merged(stored: object, incoming: Envelope) -> Meta:
    meta = clean_meta(stored)
    for name, entry in incoming["snippets"].items():
        meta["snippets"].setdefault(name, entry)
    meta["ignored"] += [pair for pair in incoming["ignored"] if pair not in meta["ignored"]]
    meta["updated"] = now_iso()
    return meta
