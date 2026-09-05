"""These imports populate utils._ROUTES through decorator side effects.
Route modules must not import each other; shared work belongs in queries.
"""

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
