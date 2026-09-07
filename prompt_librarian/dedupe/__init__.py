"""Accept record iterables, DupeIndex, or store candidate protocols.
Keep-both pairs annotate find_similar results; counts still reflect all
duplicates in the library.
"""

# Exposed for compatibility with callers that instrument SequenceMatcher.
from .core import difflib as difflib
from .cache import (
    ALL_CACHE_MAX,
    INDEX_CACHE_MAX,
    ONE_CACHE_MAX,
    cache_stats,
    cached_all_settings,
    invalidate,
)
from .core import DEFAULT_THRESHOLD, SIM_MAX_CHARS, length_ok, ratio, sim_norm
from .diffing import (
    ARROW,
    DIFF_OPCODE_CAP,
    ELLIPSIS,
    LQUO,
    RQUO,
    SUMMARY_MAX_CHANGES,
    SUMMARY_MAX_TOKENS,
    _tok_pairs,
    compare,
    diff_summary,
    diff_tokens,
)
from .index import (
    DF_ABS,
    DF_FRAC,
    OVERLAP_FRAC,
    RARE_TOKENS,
    SHORT_DOC_TOKENS,
    DupeIndex,
    build_dupe_index,
)
from .matching import find_similar, page_dupe_counts
from .scanning import dupe_counts, dupe_ids, patch

__all__ = [
    "ALL_CACHE_MAX",
    "ARROW",
    "DEFAULT_THRESHOLD",
    "DF_ABS",
    "DF_FRAC",
    "DIFF_OPCODE_CAP",
    "DupeIndex",
    "ELLIPSIS",
    "INDEX_CACHE_MAX",
    "LQUO",
    "ONE_CACHE_MAX",
    "OVERLAP_FRAC",
    "RARE_TOKENS",
    "RQUO",
    "SHORT_DOC_TOKENS",
    "SIM_MAX_CHARS",
    "SUMMARY_MAX_CHANGES",
    "SUMMARY_MAX_TOKENS",
    "build_dupe_index",
    "cache_stats",
    "cached_all_settings",
    "compare",
    "diff_summary",
    "diff_tokens",
    "dupe_counts",
    "dupe_ids",
    "find_similar",
    "invalidate",
    "length_ok",
    "page_dupe_counts",
    "patch",
    "ratio",
    "sim_norm",
]
