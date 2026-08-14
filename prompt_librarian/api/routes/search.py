"""The one read the panel's list is built from.

The work is :func:`..queries._run_search`, shared with the ``/bulk/*`` writes
that re-run a stored query. All this handler decides is whether the call is
cheap enough to run on the event loop.
"""

from .. import schemas
from ..queries import _run_search
from ..utils import _bool, _json, _offload, _query, _route


@_route("get", "/search", op="searchPrompts",
        summary="Filter, sort, page and badge the library.",
        query=schemas.SearchQuery, returns=schemas.SearchResponse)
async def search_route(request):
    params = _query(request)
    if _bool(params.get("dupes_only")):
        # The only search shape that pays the all-pairs cost, so it is the only
        # one that leaves the event loop.
        return _json(await _offload(_run_search, params))
    return _json(_run_search(params))
