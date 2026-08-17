"""Turning a params mapping into a search, and a selection into ids.

Read-path plumbing with more than one caller, which is the only reason it is
not inside a route module: ``/search`` runs the query the panel just typed,
and every ``/bulk/*`` write re-runs a query the panel *stored*. Both go
through :func:`_run_search`, so the two can never drift into disagreeing about
what "everything currently filtered" means.

:func:`_all_pairs` lives here for the same reason and no other: ``/dupes/all``
serves it directly and ``/search`` needs it to fold clusters, and two route
modules are not allowed to import each other.

Nothing here touches aiohttp or a request — the callers hand over a plain
mapping, whether it came from a query string or a JSON body. :func:`_all_pairs`
is async only because it coalesces concurrent callers; it still knows nothing
about HTTP.
"""

import asyncio

from .. import dedupe, search
from ..store import STORE
from .config import BULK_QUERY_LIMIT
from .utils import _bool, _int, _list, _offload, _rev, _str, _threshold

# -- /dupes/all coalescing --------------------------------------------------- #
# Concurrent callers on the same (rev, threshold, exhaustive) await one
# computation instead of stampeding the executor with n identical 0.5-2 s
# scans. The dict is only ever touched from the event loop, so it needs no lock.
#
# `group=true` searches made this load-bearing rather than merely polite: the
# panel fires a search per keystroke and every one of them wants the same
# clusters, so without coalescing a cold cache turns one scan into a dozen.

_all_inflight = {}


async def _all_pairs(threshold, exhaustive=False):
    """The library-wide near-duplicate scan, computed once per concurrent set.

    Returns ``dedupe.dupe_counts()``'s full result: ``counts``, ``groups`` and
    ``pairs``.
    """
    # `ignored_pairs()` calls `ensure_loaded()`, which bumps `rev` when the file
    # changed underneath us. Do it *before* computing the key, or the leader can
    # register under a rev that later callers no longer compute — which silently
    # un-coalesces the stampede this function exists to prevent.
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
    # Publish the marker, then yield once before starting the work. Under
    # eagerly-started tasks (3.12+ eager factories, 3.14's gather) a leader
    # whose executor future resolves without suspending would otherwise run to
    # completion — marker set *and* torn down — before a single peer got to
    # look, and the stampede this function prevents would happen anyway.
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
    """Run one search from a params mapping (query string or JSON body).

    ``match_id`` turns on the ``match_pct`` badge: similarity of every hit on
    the page to that record. It is derived from ``find_similar`` (one cached
    one-vs-N pass), so rows below the threshold simply carry no badge —
    which is what the panel wants, since a sub-threshold percentage is noise.

    ``group`` folds near-duplicate clusters into one row each. Both it and
    ``dupes_only`` need the all-pairs scan, so the handler is expected to have
    awaited :func:`_all_pairs` and to pass the result in as ``all_pairs``;
    computing it here would mean doing it once per concurrent search.

    Neither the badge nor the clusters consult the store's "keep both" set. A
    mute silences the save dialog, it does not make a duplicate stop existing
    — see the ``dedupe`` module docstring.
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
        # Ungrouped, always: "everything currently filtered" is a set of
        # RECORDS. A stored selector that folded clusters would hand the bulk
        # op one representative per cluster and silently spare its duplicates,
        # which is the exact opposite of what someone deleting duplicates in
        # bulk is asking for.
        query = dict(query, group=False)
        result = _run_search(query, limit=BULK_QUERY_LIMIT)
        return [hit["id"] for hit in result.get("hits", [])]
    return []
