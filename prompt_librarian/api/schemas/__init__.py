"""What every endpoint takes and hands back, as types, one module per route group.

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

from .base import (
    Envelope,
    Error,
    Prompt,
    PromptResponse,
    Version,
    VersionPreview,
)
from .prompts import (
    CreateBody,
    DeleteResponse,
    GetPromptQuery,
    MergeBody,
    MergeNewBody,
    MetaBody,
    MetaResponse,
    PromptIdBody,
    PromptMeta,
    RateBody,
    UpdateBody,
    UsageBody,
    UsageResponse,
)
from .versions import (
    GetVersionQuery,
    ListVersionsQuery,
    RestoreVersionBody,
    VersionResponse,
    VersionsResponse,
)
from .search import (
    AutocompleteQuery,
    AutocompleteResponse,
    AutocompleteSuggestion,
    SearchHit,
    SearchQuery,
    SearchResponse,
)
from .dupes import (
    CompareBody,
    CompareResponse,
    DiffChunk,
    DupeMatch,
    DupesAllQuery,
    DupesAllResponse,
    DupesBody,
    DupesResponse,
    IgnoreDupeBody,
    IgnoreDupeResponse,
)
from .wildcards import (
    ResolveBody,
    ResolveResponse,
    WildcardPick,
    WildcardsResponse,
)
from .snippets import (
    Snippet,
    SnippetBody,
    SnippetsResponse,
)
from .taxonomy import (
    TagCount,
    TaxonomyResponse,
)
from .bulk import (
    BulkCountResponse,
    BulkMergeBody,
    BulkMergeResponse,
    BulkRetagBody,
    BulkTarget,
)
from .dictionary import (
    DictionaryQuery,
    DictionaryResponse,
    DictionarySearchQuery,
    DictionarySearchResponse,
    GalleryQuery,
    GalleryResponse,
    GalleryWord,
    InstallDictionaryBody,
    InstallDictionaryResponse,
    Meaning,
)
from .library import (
    Capabilities,
    CompactStorageResponse,
    ExportResponse,
    ImportBody,
    ImportFileQuery,
    ImportResponse,
    Library,
    MigrateStorageResponse,
    PingResponse,
    Settings,
    SettingsBody,
    SettingsResponse,
    StorageResponse,
)
from .word_images import (
    AttachWordImageBody,
    AttachWordImageResponse,
    OrderWordImagesBody,
    OrderWordImagesResponse,
    PictureRef,
    RemoveWordImageBody,
    RemoveWordImageResponse,
    WordCandidatesQuery,
    WordCandidatesResponse,
    WordImageQuery,
    WordImageResponse,
    WordImagesResponse,
    WordPicture,
    WordPictureEntry,
)
