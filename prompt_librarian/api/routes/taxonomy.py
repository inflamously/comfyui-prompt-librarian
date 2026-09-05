from ...features.library import taxonomy as library_taxonomy
from .. import schemas
from ..utils import _json, _lib, _route


@_route("get", "/taxonomy", op="getTaxonomy",
        summary="Everything the filter rail needs: the tags, with counts.",
        returns=schemas.TaxonomyResponse)
async def taxonomy(request):
    return _json(library_taxonomy.taxonomy(_lib()))
