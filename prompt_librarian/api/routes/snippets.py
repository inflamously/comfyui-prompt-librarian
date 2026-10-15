"""Return the complete snippet map so editors can expand snippets locally."""

from ...features.library.snippets import edit_snippet, list_snippets
from .. import schemas
from ..utils import _body, _json, _lib, _offload, _route, _str


@_route("get", "/snippets", op="listSnippets",
        summary="Every `[[snippet]]` body, keyed by name.",
        returns=schemas.SnippetsResponse)
async def snippets(request):
    return _json({"snippets": list_snippets(_lib())})


@_route("post", "/snippet", op="editSnippet",
        summary="Set or delete one `[[snippet]]`; returns the whole snippet map.",
        body=schemas.SnippetBody, returns=schemas.SnippetsResponse)
async def snippet(request):
    data = await _body(request)
    return _json({"snippets": await _offload(
        edit_snippet, _lib(), _str(data.get("op")), _str(data.get("name")), _str(data.get("body")),
    )})
