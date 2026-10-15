"""Wildcard routes: list and resolve."""

from ...features import wildcards  # the module, so endpoints see a replaced FILES index
from ...features.library.snippets import list_snippets
from .. import schemas
from ..utils import _body, _int, _json, _lib, _route, _str


@_route("get", "/wildcards", op="listWildcards",
        summary="Names of the `__wildcard__` files, their directory and its signature.",
        returns=schemas.WildcardsResponse)
async def wildcards_route(request):
    files = wildcards.FILES
    return _json({
        "names": files.names(),
        "dir": files.root(),
        "signature": files.dir_signature(),
    })


@_route("post", "/resolve", op="resolveWildcards",
        body=schemas.ResolveBody, returns=schemas.ResolveResponse)
async def resolve(request):
    """Sample ``n`` wildcard resolutions in one call for the preview popover."""
    data = await _body(request)
    return _json(wildcards.sample(
        _str(data.get("text")), _int(data.get("seed"), 0), _int(data.get("n"), 1),
        snippets=list_snippets(_lib()),
    ))
