"""Resolve query selections inside the mutation's executor hop; resolution may
scan the library. Return resolved IDs so the client knows what changed.
"""

from ...store import STORE
from .. import schemas
from ..queries import _resolve_ids
from ..utils import _body, _json, _list, _offload, _route, _str


@_route("post", "/bulk/delete", op="bulkDeletePrompts",
        summary="Delete every selected record.",
        body=schemas.BulkTarget, returns=schemas.BulkCountResponse)
async def bulk_delete(request):
    data = await _body(request)

    def _work():
        ids = _resolve_ids(data)
        return ids, STORE.bulk_delete(ids)

    ids, count = await _offload(_work)
    return _json({"count": count, "ids": ids})


@_route("post", "/bulk/retag", op="bulkRetagPrompts",
        summary="Add, remove or wholesale replace tags across the selection.",
        body=schemas.BulkRetagBody, returns=schemas.BulkCountResponse)
async def bulk_retag(request):
    data = await _body(request)

    def _work():
        ids = _resolve_ids(data)
        count = STORE.bulk_retag(
            ids,
            add=_list(data.get("add")),
            remove=_list(data.get("remove")),
            replace=(_list(data.get("replace")) if "replace" in data else None),
        )
        return ids, count

    ids, count = await _offload(_work)
    return _json({"count": count, "ids": ids})


@_route("post", "/bulk/merge", op="bulkMergePrompts",
        summary="Merge the selection into one record.",
        body=schemas.BulkMergeBody, returns=schemas.BulkMergeResponse)
async def bulk_merge(request):
    data = await _body(request)

    def _work():
        ids = _resolve_ids(data)
        winner = _str(data.get("winner")) or None
        return ids, STORE.bulk_merge(ids, winner=winner)

    ids, rec = await _offload(_work)
    return _json({"prompt": rec, "ids": ids})
