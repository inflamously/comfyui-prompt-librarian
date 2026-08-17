"""The one read the panel's list is built from.

The work is :func:`..queries._run_search`, shared with the ``/bulk/*`` writes
that re-run a stored query. All this handler decides is whether the call is
cheap enough to run on the event loop, and — when it is not — it awaits the
all-pairs scan through the coalescer first so that a burst of keystrokes costs
one scan rather than one per keystroke.
"""

from .. import schemas
from ..queries import _all_pairs, _run_search
from ..utils import _bool, _json, _offload, _query, _route, _threshold


@_route("get", "/search", op="searchPrompts",
        summary="Filter, sort, page and badge the library.",
        query=schemas.SearchQuery, returns=schemas.SearchResponse)
async def search_route(request):
    params = _query(request)
    # `group` folds duplicate clusters into one row each; `dupes_only` filters
    # to the records that have any. Both need the library-wide scan, and both
    # are therefore too expensive for the event loop.
    if not (_bool(params.get("group")) or _bool(params.get("dupes_only"))):
        return _json(_run_search(params))
    scan = await _all_pairs(_threshold(params.get("threshold")))
    return _json(await _offload(_run_search, params, all_pairs=scan))
