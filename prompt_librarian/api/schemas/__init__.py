"""Request and response types per route group, as plain dataclasses read by OpenAPI."""

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
