"""Await the coalesced all-pairs scan when grouping requires it, so concurrent
searches do not launch duplicate scans.
"""

from ...store import STORE
from .. import schemas
from ..queries import _all_pairs, _run_search
from ..utils import _bool, _int, _json, _offload, _query, _route, _threshold


@_route("get", "/search", op="searchPrompts",
        summary="Filter, sort, page and badge the library.",
        query=schemas.SearchQuery, returns=schemas.SearchResponse)
async def search_route(request):
    params = _query(request)
    # Grouping and dupes_only require the expensive library-wide scan.
    if not (_bool(params.get("group")) or _bool(params.get("dupes_only"))):
        return _json(_run_search(params))
    scan = await _all_pairs(_threshold(params.get("threshold")))
    return _json(await _offload(_run_search, params, all_pairs=scan))


@_route("get", "/autocomplete", op="autocompletePrompts",
        summary="Suggest words and phrases from current saved prompt bodies.",
        query=schemas.AutocompleteQuery, returns=schemas.AutocompleteResponse)
async def autocomplete_route(request):
    params = _query(request)
    suggestions = await _offload(
        STORE.autocomplete, str(params.get("word_prefix", "")),
        str(params.get("phrase_prefix", "")), max(1, min(20, _int(params.get("limit"), 8))),
    )
    return _json({"suggestions": suggestions})
