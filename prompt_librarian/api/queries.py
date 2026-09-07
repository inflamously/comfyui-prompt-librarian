"""Share query evaluation between search and bulk selection so they target
the same records. Coalesce concurrent all-pairs scans before offloading.
"""

import asyncio

from .. import dedupe, search
from ..store import STORE
from .config import BULK_QUERY_LIMIT
from .utils import _bool, _int, _list, _offload, _rev, _str, _threshold

# Coalesce by (rev, threshold, exhaustive). Only the event loop touches this map.

_all_inflight = {}


async def _all_pairs(threshold, exhaustive=False):
    """The library-wide near-duplicate scan, computed once per concurrent set.

    Returns ``dedupe.dupe_counts()``'s full result: ``counts``, ``groups`` and
    ``pairs``.
    """
    # Refresh before keying: external changes may bump rev and split concurrent
    # callers across different keys.
    STORE.ensure_loaded()
    key = (_rev(), float(threshold), bool(exhaustive))
    entry = _all_inflight.get(key)
    if entry is not None:
        event, box = entry
        await event.wait()
        if "error" in box:
            raise box["error"]
        if "result" in box:
            return box["result"]
        # The leader vanished without a result; fall through and compute.
    event = asyncio.Event()
    box = {}
    _all_inflight[key] = (event, box)
    # Yield after publishing the marker so eagerly started tasks can join before
    # a fast executor result removes it.
    await asyncio.sleep(0)
    try:
        box["result"] = await _offload(
            dedupe.dupe_counts, STORE, threshold,
            rev=key[0], exhaustive=exhaustive,
        )
    except Exception as exc:
        box["error"] = exc
        raise
    finally:
        _all_inflight.pop(key, None)
        event.set()
    return box["result"]


def _run_search(params, limit=None, all_pairs=None):
    """Share query semantics between search and bulk selection.

    match_id annotates above-threshold matches. Grouping and dupes_only need
    all_pairs; async callers should await the coalesced scan before calling.
    Keep-both decisions do not remove matches or clusters.
    """
    rev = _rev()
    threshold = _threshold(params.get("threshold"))

    query = _str(params.get("q") or params.get("query") or "")
    tags = _list(params.get("tags"))
    dupes_only = _bool(params.get("dupes_only"))
    grouped = _bool(params.get("group"))
    sort = _str(params.get("sort") or "relevance")
    mode = _str(params.get("mode") or "all")
    offset = _int(params.get("offset"), 0)
    page = _int(params.get("limit"), 50) if limit is None else limit
    match_id = _str(params.get("match_id") or "")

    ids = None
    groups = None
    if dupes_only or grouped:
        scan = all_pairs
        if scan is None:
            # A caller that did not pre-compute (the bulk re-run path, tests).
            scan = dedupe.dupe_counts(STORE, threshold, rev=rev)
        if dupes_only:
            ids = dedupe.dupe_ids(scan)
        if grouped:
            groups = scan.get("groups") or []

    def _counts(pids):
        return dedupe.page_dupe_counts(STORE, pids, threshold, rev=rev)

    match_fn = None
    if match_id:
        def _matches(pids):
            hits = dedupe.find_similar(STORE, pid=match_id, exclude_id=match_id,
                                       threshold=threshold, limit=0,
                                       with_summary=False, rev=rev)
            table = {hit["id"]: hit["score"] for hit in hits}
            return {pid: table[pid] for pid in pids if pid in table}
        match_fn = _matches

    return search.search(
        STORE, query,
        tags=tags, dupes_only=dupes_only,
        sort=sort, mode=mode, offset=offset, limit=page,
        threshold=threshold, rev=rev, dupe_ids=ids,
        dupe_count_fn=_counts, match_fn=match_fn, groups=groups,
    )


def _resolve_ids(data):
    """Ids for a bulk op: explicit ``ids``, or every hit of a stored ``query``.

    "Select all filtered" over 1 284 prompts must not ship 1 284 ids through
    the browser, so the frontend stores the *query* instead and the server
    re-runs it. Runs inside the executor with the mutation it feeds.
    """
    ids = data.get("ids")
    if isinstance(ids, (list, tuple)) and ids:
        return [_str(pid) for pid in ids if _str(pid)]
    query = data.get("query")
    if isinstance(query, dict):
        # Bulk selection must stay ungrouped so every matching record is affected,
        # not just each cluster representative.
        query = dict(query, group=False)
        result = _run_search(query, limit=BULK_QUERY_LIMIT)
        return [hit["id"] for hit in result.get("hits", [])]
    return []
