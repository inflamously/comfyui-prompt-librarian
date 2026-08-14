"""Turning a params mapping into a search, and a selection into ids.

Read-path plumbing with more than one caller, which is the only reason it is
not inside a route module: ``/search`` runs the query the panel just typed,
and every ``/bulk/*`` write re-runs a query the panel *stored*. Both go
through :func:`_run_search`, so the two can never drift into disagreeing about
what "everything currently filtered" means.

Nothing here touches aiohttp or a request — the callers hand over a plain
mapping, whether it came from a query string or a JSON body.
"""

from .. import dedupe, search
from ..store import STORE
from .config import BULK_QUERY_LIMIT
from .utils import _bool, _ignored, _int, _list, _rev, _str, _threshold


def _run_search(params, limit=None):
    """Run one search from a params mapping (query string or JSON body).

    ``match_id`` turns on the ``match_pct`` badge: similarity of every hit on
    the page to that record. It is derived from ``find_similar`` (one cached
    one-vs-N pass), so rows below the threshold simply carry no badge —
    which is what the panel wants, since a sub-threshold percentage is noise.
    """
    rev = _rev()
    threshold = _threshold(params.get("threshold"))
    ignored = _ignored()

    query = _str(params.get("q") or params.get("query") or "")
    category = params.get("category")
    category = _str(category) if category not in (None, "") else None
    tags = _list(params.get("tags"))
    dupes_only = _bool(params.get("dupes_only"))
    sort = _str(params.get("sort") or "relevance")
    mode = _str(params.get("mode") or "all")
    offset = _int(params.get("offset"), 0)
    page = _int(params.get("limit"), 50) if limit is None else limit
    match_id = _str(params.get("match_id") or "")

    ids = None
    if dupes_only:
        # `dupes_only` is the one search path that needs the all-pairs scan.
        ids = dedupe.dupe_ids(dedupe.dupe_counts(STORE, threshold, rev=rev,
                                                 ignored=ignored))

    def _counts(pids):
        return dedupe.page_dupe_counts(STORE, pids, threshold,
                                       ignored=ignored, rev=rev)

    match_fn = None
    if match_id:
        def _matches(pids):
            hits = dedupe.find_similar(STORE, pid=match_id, exclude_id=match_id,
                                       threshold=threshold, limit=0,
                                       with_summary=False, ignored=ignored, rev=rev)
            table = {hit["id"]: hit["score"] for hit in hits}
            return {pid: table[pid] for pid in pids if pid in table}
        match_fn = _matches

    return search.search(
        STORE, query,
        category=category, tags=tags, dupes_only=dupes_only,
        sort=sort, mode=mode, offset=offset, limit=page,
        threshold=threshold, rev=rev, dupe_ids=ids,
        dupe_count_fn=_counts, match_fn=match_fn,
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
        result = _run_search(query, limit=BULK_QUERY_LIMIT)
        return [hit["id"] for hit in result.get("hits", [])]
    return []
