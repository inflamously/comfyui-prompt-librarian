"""These imports populate utils._ROUTES through decorator side effects.
Route modules must not import each other; shared work belongs in queries
or indexing.
"""

from . import bulk, dupes, library, prompts, search, snippets, taxonomy, versions, wildcards

__all__ = [
    "bulk",
    "dupes",
    "library",
    "prompts",
    "search",
    "snippets",
    "taxonomy",
    "versions",
    "wildcards",
]
