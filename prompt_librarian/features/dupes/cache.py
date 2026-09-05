"""Revision-keyed caches and source coercion for dedupe operations."""

from __future__ import annotations

import threading
from collections import OrderedDict

from .index import DupeIndex
from .source import LibraryDupeSource

ONE_CACHE_MAX = 512
ALL_CACHE_MAX = 4
INDEX_CACHE_MAX = 2

_lock = threading.RLock()
_one_cache: OrderedDict[tuple, list] = OrderedDict()
_all_cache: OrderedDict[tuple, dict] = OrderedDict()
_index_cache: OrderedDict[tuple, DupeIndex] = OrderedDict()
_stats = {
    "one_calls": 0,
    "one_hits": 0,
    "all_calls": 0,
    "all_hits": 0,
    "index_builds": 0,
}


def cache_stats() -> dict[str, int]:
    """Return cache counters for tests and diagnostics."""
    with _lock:
        return dict(_stats)


def cached_all_settings(rev: int | None = None) -> list[tuple[float, bool]]:
    """Return ``(threshold, exhaustive)`` for cached all-pairs results."""
    with _lock:
        return [(key[1], key[2]) for key in _all_cache if rev is None or key[0] == int(rev)]


def invalidate(rev: int | None = None) -> None:
    """Drop all cached results, or only results belonging to ``rev``."""
    with _lock:
        if rev is None:
            _one_cache.clear()
            _all_cache.clear()
            _index_cache.clear()
            return
        rev = int(rev)
        for key in [key for key in _one_cache if key[2] == rev]:
            _one_cache.pop(key, None)
        for key in [key for key in _all_cache if key[0] == rev]:
            _all_cache.pop(key, None)
        for key in [key for key in _index_cache if key[1] == rev]:
            _index_cache.pop(key, None)


def carry_forward(old_rev: int, new_rev: int) -> int:
    """Re-key all-pairs results from ``old_rev`` to ``new_rev``.

    Only for writes that changed no body and no id (usage, tags, settings):
    similarity reads bodies alone, so pairs and groups are still exact.
    Single-probe results carry ``used``/``updated`` and stay behind.
    Returns the number of results carried.
    """
    old_rev, new_rev = int(old_rev), int(new_rev)
    with _lock:
        keys = [key for key in _all_cache if key[0] == old_rev]
        for key in keys:
            result = dict(_all_cache[key], rev=new_rev)
            _lru_put(_all_cache, (new_rev, key[1], key[2]), result, ALL_CACHE_MAX)
        return len(keys)


def _lru_put(cache: OrderedDict, key: tuple, value: object, cap: int) -> None:
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > cap:
        cache.popitem(last=False)


def _lru_get(cache: OrderedDict, key: tuple) -> object:
    if key in cache:
        cache.move_to_end(key)
        return cache[key]
    return None


def _resolve(source: object, rev: int | None = None) -> DupeIndex:
    """Coerce an index, a library source, or a record iterable into a ``DupeIndex``."""
    if isinstance(source, DupeIndex):
        if rev is not None and source.rev is None:
            source.rev = int(rev)
        return source
    if source is None:
        return DupeIndex([], rev=rev)
    if isinstance(source, LibraryDupeSource):
        source_rev = source.revision()
        key = (id(source), source_rev)
        with _lock:
            index = _lru_get(_index_cache, key)
            if index is not None:
                return index
        index = DupeIndex(source.browse(), rev=source_rev)
        with _lock:
            _stats["index_builds"] += 1
            _lru_put(_index_cache, key, index, INDEX_CACHE_MAX)
        return index
    return DupeIndex(list(source), rev=None if rev is None else int(rev))
