"""One-vs-many duplicate matching and page-local duplicate counts."""

from __future__ import annotations

import hashlib
import sys
from collections.abc import Iterable, Sequence
from typing import Any

from ..search import preview as _preview
from . import cache as _cache
from .cache import _lru_get, _lru_put, _resolve
from .core import DEFAULT_THRESHOLD, ratio, sim_norm
from .diffing import diff_summary
from .index import DupeIndex


def _public_ratio(a: str, b: str, threshold: float) -> float:
    """Honor callers that instrument the package-level similarity function."""
    package = sys.modules.get(__package__)
    scorer = getattr(package, "ratio", ratio) if package is not None else ratio
    return scorer(a, b, threshold)


def _sha1(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8", "replace")).hexdigest()


def _norm_ignored(ignored: Iterable[Any]) -> frozenset:
    result = set()
    for pair in ignored or ():
        try:
            first, second = pair
        except (TypeError, ValueError):
            continue
        result.add((first, second) if first <= second else (second, first))
    return frozenset(result)


def find_similar(  # noqa: C901 - one scoring pass, kept inline on purpose
    source: Any,
    *,
    text: str | None = None,
    pid: str | None = None,
    exclude_id: str | None = None,
    threshold: float = DEFAULT_THRESHOLD,
    limit: int = 10,
    with_summary: bool = True,
    ignored: Iterable[Any] = (),
    rev: int | None = None,
) -> list[dict[str, Any]]:
    """Return records similar to ``text`` or to record ``pid``'s body.

    Ignored pairs remain in the result and carry ``ignored: True``. A keep-both
    decision controls the save dialog; it does not redefine library contents.
    """
    disk_candidates = getattr(source, "dupe_candidate_records", None)
    disk_backed = callable(disk_candidates)
    if text is None:
        if pid is None:
            return []
        rec = source.get(pid) if disk_backed else _resolve(source, rev).records.get(pid)
        text = (rec or {}).get("body") or ""
    self_id = exclude_id if exclude_id is not None else pid
    normalized_ignored = _norm_ignored(ignored)

    probe = sim_norm(text)
    if not probe:
        return []

    if disk_backed:
        records = disk_candidates(text, threshold, (self_id,))
        source_rev = int(rev if rev is not None else source.rev())
        index = DupeIndex(records, rev=source_rev)
    else:
        index = _resolve(source, rev)

    cache_key = None
    if index.rev is not None:
        cache_key = (
            _sha1(probe),
            float(threshold),
            int(index.rev),
            self_id,
            int(limit),
            bool(with_summary),
            normalized_ignored,
        )
        with _cache._lock:
            _cache._stats["one_calls"] += 1
            hit = _lru_get(_cache._one_cache, cache_key)
            if hit is not None:
                _cache._stats["one_hits"] += 1
                return hit

    toks = frozenset(probe.split())
    exclude = [value for value in (self_id,) if value]
    candidates = (
        set(index.records)
        if disk_backed
        else index.candidates(toks, len(probe), threshold, exclude=exclude)
    )

    scored: list[tuple[float, str]] = []
    for candidate_id in candidates:
        if self_id and candidate_id == self_id:
            continue
        score = _public_ratio(probe, index.norms.get(candidate_id, ""), threshold)
        if score >= threshold and score > 0.0:
            scored.append((score, candidate_id))

    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    if limit and limit > 0:
        scored = scored[:limit]

    result: list[dict[str, Any]] = []
    for score, candidate_id in scored:
        rec = index.records.get(candidate_id, {})
        body = rec.get("body") or ""
        muted = False
        if normalized_ignored and self_id:
            pair = (self_id, candidate_id) if self_id <= candidate_id else (candidate_id, self_id)
            muted = pair in normalized_ignored
        result.append(
            {
                "id": candidate_id,
                "score": round(score, 6),
                "pct": int(round(score * 100)),
                "summary": diff_summary(text, body) if with_summary else "",
                "preview": _preview(body),
                "used": int(rec.get("used") or 0),
                "updated": str(rec.get("updated") or ""),
                "ignored": muted,
            }
        )

    if cache_key is not None:
        with _cache._lock:
            _lru_put(_cache._one_cache, cache_key, result, _cache.ONE_CACHE_MAX)
    return result


def page_dupe_counts(
    source: Any,
    pids: Sequence[str],
    threshold: float = DEFAULT_THRESHOLD,
    *,
    rev: int | None = None,
) -> dict[str, int]:
    """Return near-duplicate counts for only the requested record ids."""
    disk_candidates = getattr(source, "dupe_candidate_records", None)
    if callable(disk_candidates):
        result = {}
        getter = getattr(source, "get", None)
        for pid in pids or ():
            rec = getter(pid) if callable(getter) else None
            norm = sim_norm((rec or {}).get("body") or "")
            if not norm:
                result[pid] = 0
                continue
            count = 0
            for candidate in disk_candidates(norm, threshold, (pid,)):
                candidate_norm = sim_norm(candidate.get("body") or "")
                if _public_ratio(norm, candidate_norm, threshold) >= threshold:
                    count += 1
            result[pid] = count
        return result

    index = _resolve(source, rev)
    result: dict[str, int] = {}
    for pid in pids or ():
        norm = index.norms.get(pid)
        if not norm:
            result[pid] = 0
            continue
        toks = index.toks.get(pid) or frozenset()
        candidates = index.candidates(toks, len(norm), threshold, exclude=(pid,))
        count = 0
        for candidate_id in candidates:
            if candidate_id == pid:
                continue
            if _public_ratio(norm, index.norms.get(candidate_id, ""), threshold) >= threshold:
                count += 1
        result[pid] = count
    return result
