"""Route modules, imported so their decorators populate utils._ROUTES."""

from . import (
    bulk,
    dictionary,
    dupes,
    library,
    prompts,
    search,
    snippets,
    taxonomy,
    versions,
    wildcards,
    word_images,
)

__all__ = [
    "bulk",
    "dictionary",
    "dupes",
    "library",
    "prompts",
    "search",
    "snippets",
    "taxonomy",
    "versions",
    "wildcards",
    "word_images",
]
