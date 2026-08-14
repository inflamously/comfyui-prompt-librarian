"""The ``__wildcard__`` files, and the resolver preview built on them.

``from ... import wildcards`` deliberately binds the *domain* module over this
one's own name: the handlers read ``wildcards.FILES`` through the module rather
than importing the names, so a test (or a user changing the wildcard directory)
can swap the file index and have both endpoints see it.
"""

from ... import wildcards
from ...store import STORE
from .. import schemas
from ..utils import _body, _int, _json, _route, _str


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
    text = _str(data.get("text"))
    seed = _int(data.get("seed"), 0)
    count = max(1, min(_int(data.get("n"), 1), 50))
    snips = STORE.snippets()
    first = wildcards.resolve_verbose(text, seed, snippets=snips)
    samples = [first["text"]]
    for offset in range(1, count):
        samples.append(wildcards.resolve(text, seed + offset, snippets=snips))
    return _json({
        "text": first["text"],
        "samples": samples,
        "picks": first["picks"],
        "missing": first["missing"],
        "warnings": first["warnings"],
    })
