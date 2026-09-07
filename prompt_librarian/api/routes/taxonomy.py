from ...store import STORE
from .. import schemas
from ..utils import _json, _route


@_route("get", "/taxonomy", op="getTaxonomy",
        summary="Everything the filter rail needs: the tags, with counts.",
        returns=schemas.TaxonomyResponse)
async def taxonomy(request):
    return _json(STORE.taxonomy())
