"""Exporting the library as a portable envelope."""

import copy

from ...shared import entries, meta
from ...shared.library import Library
from .envelope import META_KEYS, Envelope, envelope_from_parts


def export_metadata(lib: Library) -> Envelope:
    """The envelope without ``prompts``, for streamed exports."""
    stored = meta.load(lib)
    return copy.deepcopy({key: stored[key] for key in META_KEYS})


def export_library(lib: Library) -> Envelope:
    """The whole library: metadata plus every record, in creation order."""
    stored = meta.load(lib)
    records = []
    if lib.exists():
        with lib.read() as con:
            records = entries.get_many(con, entries.ids(con))
    return envelope_from_parts(
        settings=stored["settings"],
        snippets=stored["snippets"],
        ignored=stored["ignored"],
        prompts=records,
        updated=stored.get("updated", ""),
        schema=stored.get("schema"),
    )
