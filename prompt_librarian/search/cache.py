"""Revision-keyed live-store index caching and source coercion."""

from __future__ import annotations

import threading
from typing import Any

from .index import SearchIndex

_index_lock = threading.RLock()
_index_cache: dict[int, SearchIndex] = {}
_index_owner: int | None = None


def get_index(store: Any) -> SearchIndex:
    """Cache by store.rev(); the store must also expose list_all()."""
    global _index_owner
    rev = int(store.rev())
    key = id(store)
    with _index_lock:
        if _index_owner != key:
            _index_cache.clear()
            _index_owner = key
        idx = _index_cache.get(rev)
        if idx is None:
            projected = getattr(store, "list_search_records", None)
            records = projected() if callable(projected) else store.list_all()
            idx = SearchIndex(records, rev=rev)
            _index_cache.clear()
            _index_cache[rev] = idx
        return idx


def invalidate_index(rev: int | None = None) -> None:
    """Drop the cached store index (all of it, or one rev)."""
    with _index_lock:
        if rev is None:
            _index_cache.clear()
        else:
            _index_cache.pop(int(rev), None)


def _as_index(source: Any, rev: int | None = None) -> SearchIndex:
    if isinstance(source, SearchIndex):
        return source
    if source is None:
        return SearchIndex([], rev=rev or 0)
    list_all = getattr(source, "list_all", None)
    rev_fn = getattr(source, "rev", None)
    if callable(list_all) and callable(rev_fn):
        return get_index(source)
    return SearchIndex(list(source), rev=rev or 0)
