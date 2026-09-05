"""The browse index cached per source and revision, and source coercion."""

from __future__ import annotations

import threading

from .index import SearchIndex
from .source import LibrarySearchSource

_index_lock = threading.RLock()
_index_cache: dict[int, SearchIndex] = {}
_index_owner: int | None = None


def get_index(source: LibrarySearchSource) -> SearchIndex:
    """The browse index for a library, cached per source and revision."""
    global _index_owner
    rev = source.revision()
    key = id(source)
    with _index_lock:
        if _index_owner != key:
            _index_cache.clear()
            _index_owner = key
        idx = _index_cache.get(rev)
        if idx is None:
            idx = SearchIndex(source.browse(), rev=rev)
            _index_cache.clear()
            _index_cache[rev] = idx
        return idx


def invalidate_index(rev: int | None = None) -> None:
    """Drop the cached index (all of it, or one revision)."""
    with _index_lock:
        if rev is None:
            _index_cache.clear()
        else:
            _index_cache.pop(int(rev), None)


def _as_index(source: object, rev: int | None = None) -> SearchIndex:
    if isinstance(source, SearchIndex):
        return source
    if source is None:
        return SearchIndex([], rev=rev or 0)
    if isinstance(source, LibrarySearchSource):
        return get_index(source)
    return SearchIndex(list(source), rev=rev or 0)
