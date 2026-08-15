"""The filter rail: the tags, with counts.

Tags have no write endpoint of their own — they exist only as a field on
records, so ``/bulk/retag`` is where they are written and this is where they
are read.
"""

from ...store import STORE
from .. import schemas
from ..utils import _json, _route


@_route("get", "/taxonomy", op="getTaxonomy",
        summary="Everything the filter rail needs: the tags, with counts.",
        returns=schemas.TaxonomyResponse)
async def taxonomy(request):
    return _json(STORE.taxonomy())
