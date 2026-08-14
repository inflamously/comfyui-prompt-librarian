"""``[[snippet]]`` bodies — read the whole map, or write one entry.

Both endpoints hand back the entire map. It is small, and the panel keeps it
resident so that every editor can expand a snippet without a round trip; a
partial response would only give it something to reconcile.
"""

from ...store import STORE
from .. import schemas
from ..utils import _body, _json, _offload, _route, _str


@_route("get", "/snippets", op="listSnippets",
        summary="Every `[[snippet]]` body, keyed by name.",
        returns=schemas.SnippetsResponse)
async def snippets(request):
    return _json({"snippets": STORE.snippets()})


@_route("post", "/snippet", op="editSnippet",
        summary="Set or delete one `[[snippet]]`; returns the whole snippet map.",
        body=schemas.SnippetBody, returns=schemas.SnippetsResponse)
async def snippet(request):
    data = await _body(request)
    op = _str(data.get("op") or "set").strip().lower()
    name = _str(data.get("name"))

    def _work():
        if op == "set":
            STORE.set_snippet(name, _str(data.get("body")))
        elif op == "delete":
            STORE.delete_snippet(name)
        else:
            raise ValueError(f"unknown snippet op {op!r}")
        return STORE.snippets()

    return _json({"snippets": await _offload(_work)})
