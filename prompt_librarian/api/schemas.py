"""What every endpoint takes and hands back, as types.

Nothing here imports pydantic — these are plain :mod:`dataclasses`, so what
ComfyUI pays is ~60 class definitions at startup (single-digit milliseconds)
and nothing at all per request. :mod:`.openapi` is the only thing that reads
them, and the only thing that needs pydantic installed:
``TypeAdapter(SomeClass).json_schema()`` does all the JSON Schema work, so
there is no hand-written schema anywhere in this package.

Three conventions carry most of the meaning:

* **A default means "may be omitted", and says what happens when it is.**
  A field with no default is a required parameter. Defaults are copied from the
  handler's own coercion call (``_int(params.get("limit"), 50)`` -> ``limit:
  int = 50``), so they are worth keeping honest when a handler changes.
* **``X | None = None`` means the field is genuinely absent-or-null** — a
  partial update that leaves a field alone, a threshold that falls back to the
  persisted setting, a body that may or may not be there.
* **Every response inherits :class:`Envelope`**, which is where the ``rev`` that
  :func:`utils._json` merges into every payload comes from. A response type
  that does not inherit it is a bug, and ``tests/test_openapi.py`` says so.

An attribute docstring becomes the field's ``description`` in the spec (via
:attr:`_Schema.__pydantic_config__`), and a class docstring becomes the
schema's. They are here for the fields whose name is not the whole story, not
for every field.
"""

from dataclasses import dataclass, field
from typing import Literal


class _Schema:
    """Base for every declaration here — turns attribute docstrings into docs.

    ``ConfigDict`` is only a ``TypedDict``, so the config can be a plain dict
    literal and this module stays free of the pydantic import.
    """

    __pydantic_config__ = {"use_attribute_docstrings": True}


@dataclass
class Envelope(_Schema):
    """Merged into every response, errors included."""

    rev: int
    """The store revision this response was built from."""


# --------------------------------------------------------------------------- #
# The record, and the shapes derived from it
# --------------------------------------------------------------------------- #

@dataclass
class Version(_Schema):
    """One entry in a record's history."""

    body: str
    ts: str
    src: str | None
    """What produced the snapshot, or null for an ordinary edit."""


@dataclass
class VersionPreview(_Schema):
    """A version without its body — what the history list renders."""

    index: int
    label: str
    """Derived from the snapshotted body; empty for an empty one."""
    ts: str
    src: str | None
    chars: int
    """Length of the full body this preview was cut from."""
    preview: str


@dataclass
class Prompt(_Schema):
    """A library record.

    No name: a record *is* its body. Every response that needs a handle for one
    carries a derived ``label`` instead, and this type deliberately does not —
    it is also the shape ``/export`` writes and ``/import`` reads, and a
    derived field in a file would be a stored name again by another route.
    """

    id: str
    """``uuid4().hex``, stable across edits and never a content hash."""
    body: str
    tags: list[str]
    rating: int
    used: int
    """Times this exact saved body has been run."""
    last_run: str
    created: str
    updated: str
    """Also the concurrency token: pass it back as ``expect_updated``."""
    notes: str
    pinned: bool
    versions: list[Version]


@dataclass
class SearchHit(_Schema):
    """One row of a search page."""

    id: str
    label: str
    """The row's handle: this body's most distinctive terms, against the rest
    of the library. Derived per response, never stored, and free to change when
    the library around it does — sort and filter on the other fields."""
    preview: str
    tags: list[str]
    rating: int
    used: int
    last_run: str
    updated: str
    chars: int
    version_count: int
    score: float
    dupe_count: int
    """Near-duplicates of this record, counted for this page only. Counts every
    one of them: a "keep both" mute silences the save dialog, it does not make
    a duplicate stop existing."""
    match_pct: int | None
    """Similarity to ``match_id``; null when below the threshold, or unasked."""
    group_size: int
    """Records in this row's near-duplicate cluster, itself included. Always 1
    unless ``group`` was asked for. When it exceeds the members listed under
    ``groups[id]``, the rest were capped away — the count is still the truth."""


@dataclass
class PromptMeta(_Schema):
    """The subset of a record a node face shows."""

    label: str
    rating: int
    used: int
    tags: list[str]
    near_dupes: int
    updated: str


@dataclass
class DupeMatch(_Schema):
    """One near-duplicate of the body that was asked about."""

    id: str
    label: str
    score: float
    pct: int
    summary: str
    """Human diff summary, empty when ``summaries`` was false."""
    preview: str
    used: int
    updated: str
    ignored: bool
    """True when this pair carries a "keep both" decision. The match is still
    reported — muting is the save gate's business, not a claim that the
    duplicate went away — and it is the caller that acts on the flag."""


@dataclass
class DiffChunk(_Schema):
    """One word-level opcode, ``equal`` runs included."""

    op: Literal["equal", "replace", "insert", "delete"]
    a_start: int
    a_end: int
    b_start: int
    b_end: int
    a_tokens: list[str]
    b_tokens: list[str]


@dataclass
class WildcardPick(_Schema):
    """One substitution a resolve pass made."""

    kind: Literal["wildcard", "snippet", "choice"]
    name: str
    value: str
    count: int | None = None
    """How many options were on offer — wildcard files only."""


@dataclass
class Snippet(_Schema):
    """A reusable ``[[snippet]]`` body."""

    body: str
    updated: str


@dataclass
class Settings(_Schema):
    """The persisted settings block."""

    dupe_threshold: float
    version_cap: int


@dataclass
class TagCount(_Schema):
    tag: str
    count: int


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
class Error(Envelope):
    """Mirrors ``config._ERROR_MAP``; `internal` is the guard's fallback."""

    error: str
    code: Literal["not_found", "too_large", "readonly", "conflict",
                  "same_record", "write_failed", "bad_request", "internal"]
    """Branch on this, never on the prose."""


# --------------------------------------------------------------------------- #
# GET
# --------------------------------------------------------------------------- #

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
class SearchQuery(_Schema):
    """The filter/sort/page parameters, also storable as a bulk selector."""

    q: str = ""
    query: str = ""
    """Alias of ``q``, so a stored selector round-trips unchanged."""
    tags: list[str] = field(default_factory=list)
    dupes_only: bool = False
    """Filter to records that have at least one near-duplicate."""
    group: bool = False
    """Fold each near-duplicate cluster into a single row, its members returned
    under ``groups``. Together with ``dupes_only`` these are the two search
    shapes that pay for the all-pairs scan."""
    sort: Literal["relevance", "recent", "most_used", "az"] = "relevance"
    mode: Literal["all", "any"] = "all"
    offset: int = 0
    limit: int = 50
    threshold: float | None = None
    """Similarity threshold; null falls back to the persisted setting."""
    match_id: str = ""
    """Badge every hit with its similarity to this record."""


@dataclass
class SearchResponse(Envelope):
    total: int
    """Rows to page over: clusters and singletons when ``group`` is on, records
    otherwise. This is what ``offset`` counts in."""
    offset: int
    limit: int
    threshold: float
    took_ms: float
    dupes_partial: bool
    """True when `dupes_only` could not be applied and the filter was skipped."""
    fallback: bool
    """True when the query missed and the infix/edit-1 vocabulary scan ran."""
    hits: list[SearchHit]
    record_total: int
    """Records behind those rows. Equal to ``total`` unless ``group`` folded
    clusters — that is the number a "select all filtered" bulk op will act on."""
    groups: dict[str, list[SearchHit]]
    """``{representative id: the rest of its cluster}``, for the hits on this
    page that have any. A flat sibling map rather than members nested inside
    the hit, because a self-referential ``SearchHit`` is not something the
    OpenAPI generator can render."""


@dataclass
class GetPromptQuery(_Schema):
    id: str


@dataclass
class PromptResponse(Envelope):
    prompt: Prompt
    label: str
    """The record's derived handle. Beside the record rather than inside it:
    :class:`Prompt` is also what ``/export`` writes, and a derived field in a
    file on disk would be a stored name again by another route."""


@dataclass
class ListVersionsQuery(_Schema):
    id: str
    chars: int = 160
    """Preview length. Bodies are never returned here at any value."""


@dataclass
class VersionsResponse(Envelope):
    id: str
    versions: list[VersionPreview]


@dataclass
class GetVersionQuery(_Schema):
    id: str
    index: int = -1


@dataclass
class VersionResponse(Envelope):
    id: str
    index: int
    version: Version


@dataclass
class TaxonomyResponse(Envelope):
    tags: list[TagCount]
    total: int


@dataclass
class DupesAllQuery(_Schema):
    threshold: float | None = None
    exhaustive: bool = False
    """Skip the length prefilter and blocking index; slow and rarely wanted."""


@dataclass
class DupesAllResponse(Envelope):
    threshold: float
    exhaustive: bool
    counts: dict[str, int]
    """Near-duplicates per record id. Every one of them — see ``ignored``."""
    groups: list[list[str]]
    """Connected clusters of ids."""
    pairs: dict[str, list[str]]
    """Each id's partners, both directions present."""
    ignored: list[list[str]]
    """The "keep both" pairs, reported ALONGSIDE the counts rather than
    subtracted from them, so a client can mark a muted pair without having to
    guess why a number came back smaller than the library looks."""


@dataclass
class WildcardsResponse(Envelope):
    names: list[str]
    dir: str
    signature: str
    """sha1 over every wildcard file's (name, mtime, size)."""


@dataclass
class SnippetsResponse(Envelope):
    snippets: dict[str, Snippet]


@dataclass
class ExportResponse(Envelope):
    library: Library


@dataclass
class ImportFileQuery(_Schema):
    mode: Literal["merge", "replace"] = "merge"
    """Merge preserves current prompts; replace swaps the library wholesale."""


# --------------------------------------------------------------------------- #
# POST — reads
# --------------------------------------------------------------------------- #

@dataclass
class MetaBody(_Schema):
    ids: list[str]
    threshold: float | None = None


@dataclass
class MetaResponse(Envelope):
    meta: dict[str, PromptMeta]
    """Keyed by id; unknown ids are simply absent."""


@dataclass
class DupesBody(_Schema):
    """The body to check, as raw ``text`` or as the ``id`` of a record."""

    text: str | None = None
    id: str | None = None
    exclude_id: str | None = None
    """Required when saving an existing record, or it matches itself at 100%."""
    threshold: float | None = None
    limit: int = 10
    summaries: bool = True


@dataclass
class DupesResponse(Envelope):
    matches: list[DupeMatch]
    threshold: float


@dataclass
class CompareBody(_Schema):
    """Each side is given as ``<k>_text``, or as ``<k>_id`` / ``<k>``."""

    a: str = ""
    a_id: str = ""
    a_text: str | None = None
    b: str = ""
    b_id: str = ""
    b_text: str | None = None


@dataclass
class CompareResponse(Envelope):
    score: float
    pct: int
    summary: str
    diff: list[DiffChunk]


@dataclass
class ResolveBody(_Schema):
    text: str
    seed: int = 0
    n: int = 1
    """Samples to draw, clamped to 1..50."""


@dataclass
class ResolveResponse(Envelope):
    text: str
    """The first sample, the one whose picks are reported."""
    samples: list[str]
    picks: list[WildcardPick]
    missing: list[str]
    warnings: list[str]


# --------------------------------------------------------------------------- #
# POST — writes
# --------------------------------------------------------------------------- #

@dataclass
class CreateBody(_Schema):
    body: str = ""
    tags: list[str] = field(default_factory=list)
    rating: int = 0
    notes: str = ""
    pinned: bool = False


@dataclass
class UpdateBody(_Schema):
    """A partial update: every omitted field is left as it is."""

    id: str
    body: str | None = None
    tags: list[str] | None = None
    rating: int | None = None
    notes: str | None = None
    pinned: bool | None = None
    snapshot: bool = True
    """Snapshot the current body into the history first."""
    expect_updated: str | None = None
    """The record's `updated` as the client last saw it; a mismatch is a 409."""


@dataclass
class RateBody(_Schema):
    id: str
    rating: int


@dataclass
class PromptIdBody(_Schema):
    id: str


@dataclass
class DeleteResponse(Envelope):
    deleted: bool
    id: str


@dataclass
class UsageBody(_Schema):
    id: str
    body: str | None = None
    """Checked against the stored body; a mismatch counts nothing."""


@dataclass
class UsageResponse(Envelope):
    prompt: Prompt | None
    """Null when nothing was counted."""
    counted: bool


@dataclass
class BulkTarget(_Schema):
    """The selection every `/bulk/*` body takes.

    "Select all filtered" over a large library must not ship every id through
    the browser, so the frontend may store the ``query`` instead and let the
    server re-run it.
    """

    ids: list[str] = field(default_factory=list)
    query: SearchQuery | None = None


@dataclass
class BulkRetagBody(BulkTarget):
    add: list[str] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    replace: list[str] | None = None
    """Replaces the whole tag set; `add`/`remove` are ignored when it is given."""


@dataclass
class BulkMergeBody(BulkTarget):
    winner: str = ""
    """Defaults to the first selected id."""


@dataclass
class BulkCountResponse(Envelope):
    count: int
    ids: list[str]
    """The selection the query resolved to."""


@dataclass
class BulkMergeResponse(Envelope):
    prompt: Prompt
    ids: list[str]


@dataclass
class MergeBody(_Schema):
    """``*_id`` aliases are accepted for both sides."""

    winner: str = ""
    winner_id: str = ""
    loser: str = ""
    loser_id: str = ""


@dataclass
class MergeNewBody(_Schema):
    """``body`` is required: a synthesized record has no defensible default."""

    body: str
    a: str = ""
    a_id: str = ""
    b: str = ""
    b_id: str = ""


@dataclass
class RestoreVersionBody(_Schema):
    id: str
    index: int = -1


@dataclass
class IgnoreDupeBody(_Schema):
    """The pair, as ``a``/``b`` or as ``id``/``other``."""

    a: str = ""
    b: str = ""
    id: str = ""
    other: str = ""
    unignore: bool = False


@dataclass
class IgnoreDupeResponse(Envelope):
    changed: bool
    """False when the pair was already in that state."""
    ignored: bool


@dataclass
class SnippetBody(_Schema):
    name: str
    op: Literal["set", "delete"] = "set"
    body: str = ""


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


@dataclass
class AutocompleteQuery(_Schema):
    word_prefix: str = ""
    phrase_prefix: str = ""
    limit: int = 8
    """Result count, clamped to 1–20."""


@dataclass
class AutocompleteSuggestion(_Schema):
    text: str
    """An individual word or saved phrase containing at most three words."""
    scope: Literal["word", "phrase"]
    source_count: int
    """Distinct current prompts containing this keyword."""


@dataclass
class AutocompleteResponse(Envelope):
    suggestions: list[AutocompleteSuggestion]
