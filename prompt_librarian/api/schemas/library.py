"""The library as a whole: ping, storage, settings, import and export."""

from dataclasses import dataclass
from typing import Literal

from .base import Envelope, Prompt, _Schema
from .snippets import Snippet


@dataclass
class Settings(_Schema):
    """The persisted settings block."""

    dupe_threshold: float
    version_cap: int

@dataclass
class Capabilities(_Schema):
    """What the frontend probes on startup. Mirrors ``config.CAPABILITIES``."""

    autocomplete: bool

    search: bool
    versions: bool
    diff: bool
    wildcards: bool
    snippets: bool
    bulk: bool
    dupes: bool
    storage: bool
    soft_delete: bool
    """Always false: `delete` removes the record, and versions are the undo."""
    word_images: bool
    """Pictures can be attached to words and previewed beside autocomplete."""
    dictionary: bool
    """The word gallery and its downloadable dictionary are available."""

@dataclass
class Library(_Schema):
    """The whole on-disk envelope, as exported and imported."""

    schema: int
    updated: str
    settings: Settings
    snippets: dict[str, Snippet]
    ignored: list[list[str]]
    """Pairs the user chose to keep, stored sorted."""
    prompts: list[Prompt]

@dataclass
class PingResponse(Envelope):
    ok: bool
    schema: int
    count: int
    path: str
    corrupt: bool
    readonly: bool
    threshold: float
    capabilities: Capabilities
    storage: dict

@dataclass
class StorageResponse(Envelope):
    storage: dict

@dataclass
class MigrateStorageResponse(Envelope):
    imported: int
    skipped: int
    collisions: int
    already_migrated: bool
    storage: dict

@dataclass
class CompactStorageResponse(Envelope):
    before: int
    after: int
    records: int
    storage: dict

@dataclass
class ExportResponse(Envelope):
    library: Library

@dataclass
class ImportFileQuery(_Schema):
    mode: Literal["merge", "replace"] = "merge"
    """Merge preserves current prompts; replace swaps the library wholesale."""

@dataclass
class SettingsBody(_Schema):
    dupe_threshold: float | None = None
    version_cap: int | None = None

@dataclass
class SettingsResponse(Envelope):
    settings: Settings

@dataclass
class ImportBody(_Schema):
    """The envelope to import, as ``library`` or its ``raw`` alias."""

    library: Library | None = None
    raw: Library | None = None
    replace: bool = True
    """False appends instead, re-idding anything that collides."""

@dataclass
class ImportResponse(Envelope):
    count: int
    """Records imported."""
