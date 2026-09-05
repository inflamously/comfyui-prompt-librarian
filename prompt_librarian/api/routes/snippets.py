"""Return the complete snippet map so editors can expand snippets locally."""

from ...features.library.snippets import delete_snippet, list_snippets, set_snippet
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
    op = _str(data.get("op") or "set").strip().lower()
    name = _str(data.get("name"))

    def _work():
        if op == "set":
            set_snippet(_lib(), name, _str(data.get("body")))
        elif op == "delete":
            delete_snippet(_lib(), name)
        else:
            raise ValueError(f"unknown snippet op {op!r}")
        return list_snippets(_lib())

    return _json({"snippets": await _offload(_work)})
