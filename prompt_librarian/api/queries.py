"""Query evaluation shared by search and bulk selection, with coalesced all-pairs scans."""

import asyncio

from .. import app
from ..features import dupes
from .config import BULK_QUERY_LIMIT
from .utils import _bool, _int, _list, _offload, _rev, _str, _threshold

# Coalesce by (rev, threshold, exhaustive). Only the event loop touches this map.

_all_inflight = {}


async def _all_pairs(threshold, exhaustive=False):
    """The library-wide near-duplicate scan, computed once per concurrent set."""
    # Refresh before keying: external changes may bump rev and split concurrent
    # callers across different keys.
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
            dupes.dupe_counts, app.current().dupe_source, threshold,
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
    """Parse a search query (``/search`` or a stored bulk one) and run it."""
    return app.search_prompts(
        app.current(),
        _str(params.get("q") or params.get("query") or ""),
        tags=_list(params.get("tags")),
        dupes_only=_bool(params.get("dupes_only")),
        grouped=_bool(params.get("group")),
        sort=_str(params.get("sort") or "relevance"),
        mode=_str(params.get("mode") or "all"),
        offset=_int(params.get("offset"), 0),
        limit=_int(params.get("limit"), 50) if limit is None else limit,
        threshold=_threshold(params.get("threshold")),
        match_id=_str(params.get("match_id") or ""),
        all_pairs=all_pairs,
    )


def _resolve_ids(data):
    """Ids for a bulk op: explicit ``ids``, or every hit of a stored ``query``."""
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
