"""All-pairs duplicate scans, grouping, and incremental cache patching."""

from __future__ import annotations

import sys
from typing import Any

from . import cache as _cache
from .cache import _lru_get, _lru_put, _resolve
from .core import DEFAULT_THRESHOLD, ratio, sim_norm


def _public_ratio(a: str, b: str, threshold: float) -> float:
    package = sys.modules.get(__package__)
    scorer = getattr(package, "ratio", ratio) if package is not None else ratio
    return scorer(a, b, threshold)


def _components(pairs: dict[str, dict[str, float]]) -> list[list[str]]:
    """Return connected components over the similarity graph."""
    seen: set[str] = set()
    groups: list[list[str]] = []
    for start in pairs:
        if start in seen or not pairs[start]:
            continue
        stack = [start]
        seen.add(start)
        component: list[str] = []
        while stack:
            current = stack.pop()
            component.append(current)
            for neighbor in pairs.get(current, ()):
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append(neighbor)
        if len(component) > 1:
            component.sort()
            groups.append(component)
    groups.sort(key=lambda group: (-len(group), group[0]))
    return groups


def _finish(
    pairs: dict[str, dict[str, float]],
    threshold: float,
    rev: int | None,
    exhaustive: bool,
) -> dict[str, Any]:
    return {
        "rev": rev,
        "threshold": float(threshold),
        "exhaustive": bool(exhaustive),
        "counts": {pid: len(neighbors) for pid, neighbors in pairs.items()},
        "groups": _components(pairs),
        "pairs": pairs,
    }


def dupe_counts(  # noqa: C901 - the disk and memory scans share one contract
    source: Any,
    threshold: float = DEFAULT_THRESHOLD,
    *,
    rev: int | None = None,
    exhaustive: bool = False,
) -> dict[str, Any]:
    """Run an all-pairs near-duplicate scan and return counts and groups."""
    disk_candidates = getattr(source, "dupe_candidate_records", None)
    indexed_record = getattr(source, "indexed_record", None)
    ids_fn = getattr(source, "ids", None)
    if (
        callable(disk_candidates)
        and callable(indexed_record)
        and callable(ids_fn)
        and not exhaustive
    ):
        source_rev = int(rev if rev is not None else source.rev())
        cache_key = (source_rev, float(threshold), False)
        with _cache._lock:
            _cache._stats["all_calls"] += 1
            hit = _lru_get(_cache._all_cache, cache_key)
            if hit is not None:
                _cache._stats["all_hits"] += 1
                return hit
        pids = list(ids_fn())
        positions = {pid: index for index, pid in enumerate(pids)}
        pairs: dict[str, dict[str, float]] = {pid: {} for pid in pids}
        for position, first in enumerate(pids):
            rec = indexed_record(first) or {}
            body = rec.get("body") or ""
            norm = sim_norm(body)
            if not norm:
                continue
            for other in disk_candidates(body, threshold, (first,)):
                second = str(other.get("id") or "")
                if not second or positions.get(second, -1) <= position:
                    continue
                score = _public_ratio(
                    norm,
                    sim_norm(other.get("body") or ""),
                    threshold,
                )
                if score >= threshold and score > 0.0:
                    pairs[first][second] = score
                    pairs[second][first] = score
        result = _finish(pairs, threshold, source_rev, False)
        with _cache._lock:
            _lru_put(_cache._all_cache, cache_key, result, _cache.ALL_CACHE_MAX)
        return result

    index = _resolve(source, rev)
    cache_key = None
    if index.rev is not None:
        cache_key = (int(index.rev), float(threshold), bool(exhaustive))
        with _cache._lock:
            _cache._stats["all_calls"] += 1
            hit = _lru_get(_cache._all_cache, cache_key)
            if hit is not None:
                _cache._stats["all_hits"] += 1
                return hit

    pids = list(index.records)
    positions = {pid: position for position, pid in enumerate(pids)}
    pairs = {pid: {} for pid in pids}
    for position, first in enumerate(pids):
        first_norm = index.norms.get(first, "")
        if not first_norm:
            continue
        if exhaustive:
            candidates = pids[position + 1 :]
        else:
            toks = index.toks.get(first) or frozenset()
            candidates = [
                candidate
                for candidate in index.candidates(
                    toks,
                    len(first_norm),
                    threshold,
                    exclude=(first,),
                )
                if positions.get(candidate, -1) > position
            ]
        for second in candidates:
            score = _public_ratio(first_norm, index.norms.get(second, ""), threshold)
            if score >= threshold and score > 0.0:
                pairs[first][second] = score
                pairs[second][first] = score

    result = _finish(pairs, threshold, index.rev, exhaustive)
    if cache_key is not None:
        with _cache._lock:
            _lru_put(_cache._all_cache, cache_key, result, _cache.ALL_CACHE_MAX)
    return result


def dupe_ids(result: dict[str, Any]) -> set[str]:
    """Return ids having at least one near duplicate."""
    return {pid for pid, count in (result or {}).get("counts", {}).items() if count}


def patch(  # noqa: C901 - mirrors the two all-pairs storage paths
    old_rec: dict[str, Any] | None,
    new_rec: dict[str, Any] | None,
    threshold: float = DEFAULT_THRESHOLD,
    *,
    old_rev: int | None = None,
    new_rev: int | None = None,
    source: Any = None,
    exhaustive: bool = False,
) -> dict[str, Any] | None:
    """Incrementally update a cached all-pairs result after one write."""
    pid = str((new_rec or old_rec or {}).get("id") or "")
    if not pid:
        return None

    with _cache._lock:
        if old_rev is not None:
            base = _lru_get(
                _cache._all_cache,
                (int(old_rev), float(threshold), bool(exhaustive)),
            )
        else:
            base = None
            for key in reversed(_cache._all_cache):
                if key[1] == float(threshold) and key[2] == bool(exhaustive):
                    base = _cache._all_cache[key]
                    old_rev = key[0]
                    break
        if base is None:
            return None
        pairs = {pair_id: dict(neighbors) for pair_id, neighbors in base.get("pairs", {}).items()}

    disk_candidates = getattr(source, "dupe_candidate_records", None)
    disk_backed = callable(disk_candidates) and not exhaustive
    index = _resolve(source, old_rev) if source is not None and not disk_backed else None

    for other in list(pairs.get(pid, {})):
        pairs.get(other, {}).pop(pid, None)
    pairs.pop(pid, None)

    if new_rec is not None:
        if index is None and not disk_backed:
            return None
        pairs[pid] = {}
        if disk_backed:
            norm = sim_norm(new_rec.get("body") or "")
            candidate_records = disk_candidates(
                new_rec.get("body") or "",
                threshold,
                (pid,),
            )
            for candidate in candidate_records:
                other = str(candidate.get("id") or "")
                if not other or other not in pairs:
                    continue
                score = _public_ratio(
                    norm,
                    sim_norm(candidate.get("body") or ""),
                    threshold,
                )
                if score >= threshold and score > 0.0:
                    pairs[pid][other] = score
                    pairs[other][pid] = score
        else:
            index.replace(new_rec)
            if new_rev is not None:
                index.rev = int(new_rev)
            norm = index.norms.get(pid, "")
        if not disk_backed and norm:
            toks = index.toks.get(pid) or frozenset()
            if exhaustive:
                candidates = [candidate for candidate in index.records if candidate != pid]
            else:
                candidates = index.candidates(
                    toks,
                    len(norm),
                    threshold,
                    exclude=(pid,),
                )
            for other in candidates:
                if other == pid or other not in pairs:
                    continue
                score = _public_ratio(norm, index.norms.get(other, ""), threshold)
                if score >= threshold and score > 0.0:
                    pairs[pid][other] = score
                    pairs[other][pid] = score
    elif index is not None:
        index.remove(pid)
        if new_rev is not None:
            index.rev = int(new_rev)

    result = _finish(pairs, threshold, new_rev, exhaustive)
    if new_rev is not None:
        with _cache._lock:
            _lru_put(
                _cache._all_cache,
                (int(new_rev), float(threshold), bool(exhaustive)),
                result,
                _cache.ALL_CACHE_MAX,
            )
    return result
