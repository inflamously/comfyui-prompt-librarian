"""The filter rail: categories with counts, tags, and category edits.

Tags have no endpoint of their own — they exist only as a field on records, so
``/bulk/retag`` is where they are written and this is where they are read.
"""

from ...store import STORE
from .. import schemas
from ..utils import _body, _json, _offload, _route, _str


@_route("get", "/taxonomy", op="getTaxonomy",
        summary="Everything the filter rail needs: categories with counts, and tags.",
        returns=schemas.TaxonomyResponse)
async def taxonomy(request):
    return _json(STORE.taxonomy())


@_route("post", "/category", op="editCategory",
        summary="Add, rename or delete a category.",
        body=schemas.CategoryBody, returns=schemas.CategoryResponse)
async def category(request):
    data = await _body(request)
    op = _str(data.get("op") or "add").strip().lower()
    name = _str(data.get("name"))

    def _work():
        if op == "add":
            return 0, STORE.add_category(name)
        if op == "rename":
            count = STORE.rename_category(name, _str(data.get("new")))
            return count, STORE.categories()
        if op == "delete":
            count = STORE.delete_category(name, _str(data.get("reassign_to")))
            return count, STORE.categories()
        raise ValueError(f"unknown category op {op!r}")

    count, names = await _offload(_work)
    return _json({"count": count, "categories": names})
