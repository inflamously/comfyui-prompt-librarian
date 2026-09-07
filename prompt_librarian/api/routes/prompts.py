"""Patch duplicate caches inside the same executor hop as single-record writes.
/meta uses POST for a batch of IDs despite being read-only.
"""

from ... import dedupe
from ...store import STORE, NotFoundError
from .. import schemas
from ..indexing import _patch_dupes
from ..utils import (
    _body,
    _bool,
    _int,
    _json,
    _labelled,
    _labeller,
    _list,
    _offload,
    _opt,
    _query,
    _rev,
    _route,
    _str,
    _threshold,
)


@_route("get", "/prompt", op="getPrompt",
        summary="One full record, body included.",
        query=schemas.GetPromptQuery, returns=schemas.PromptResponse)
async def prompt(request):
    pid = _str(_query(request).get("id"))
    rec = STORE.get(pid)
    if rec is None:
        raise NotFoundError(f"no prompt with id {pid!r}")
    return _json(_labelled(rec))


@_route("post", "/meta", op="getPromptMeta",
        body=schemas.MetaBody, returns=schemas.MetaResponse)
async def meta(request):
    """Batch metadata for node faces. Ten Librarian nodes = one request."""
    data = await _body(request)
    ids = [_str(pid) for pid in (data.get("ids") or []) if _str(pid)]
    records = STORE.get_many(ids)
    counts = dedupe.page_dupe_counts(STORE, list(records), _threshold(data.get("threshold")),
                                     rev=_rev())
    # Use the same revision-keyed labels as search and node faces.
    index = _labeller(records.values())
    out = {}
    for pid, rec in records.items():
        out[pid] = {
            "label": index.label_of(pid),
            "rating": int(rec.get("rating", 0) or 0),
            "used": int(rec.get("used", 0) or 0),
            "tags": list(rec.get("tags") or ()),
            "near_dupes": int(counts.get(pid, 0) or 0),
            "updated": rec.get("updated", ""),
        }
    return _json({"meta": out})


@_route("post", "/create", op="createPrompt",
        summary="Create a record and return it.",
        body=schemas.CreateBody, returns=schemas.PromptResponse)
async def create(request):
    data = await _body(request)

    def _work():
        old_rev = _rev()
        rec = STORE.create(
            body=_str(data.get("body")),
            tags=_list(data.get("tags")),
            rating=_int(data.get("rating"), 0),
            notes=_str(data.get("notes")),
            pinned=_bool(data.get("pinned")),
        )
        _patch_dupes(None, rec, old_rev)
        return _labelled(rec)

    return _json(await _offload(_work))


@_route("post", "/update", op="updatePrompt",
        summary="Partial update; omitted fields are left alone.",
        body=schemas.UpdateBody, returns=schemas.PromptResponse)
async def update(request):
    data = await _body(request)
    pid = _str(data.get("id"))

    def _work():
        old_rev = _rev()
        old = STORE.get(pid)
        rec = STORE.update(
            pid,
            body=_opt(data, "body"),
            tags=(_list(data.get("tags")) if "tags" in data else None),
            rating=(_int(data.get("rating"), 0) if "rating" in data else None),
            notes=_opt(data, "notes"),
            pinned=(_bool(data.get("pinned")) if "pinned" in data else None),
            snapshot=_bool(data.get("snapshot"), True),
            # Reject stale writes from other tabs with ConflictError (409).
            expect_updated=_opt(data, "expect_updated"),
        )
        _patch_dupes(old, rec, old_rev)
        return _labelled(rec)

    return _json(await _offload(_work))


@_route("post", "/rate", op="ratePrompt",
        summary="Set a record's 0-5 rating.",
        body=schemas.RateBody, returns=schemas.PromptResponse)
async def rate(request):
    data = await _body(request)
    pid = _str(data.get("id"))
    rating = _int(data.get("rating"), 0)
    return _json(await _offload(lambda: _labelled(STORE.set_rating(pid, rating))))


@_route("post", "/delete", op="deletePrompt",
        summary="Delete a record outright — there is no trash bin.",
        body=schemas.PromptIdBody, returns=schemas.DeleteResponse)
async def delete(request):
    data = await _body(request)
    pid = _str(data.get("id"))

    def _work():
        old_rev = _rev()
        old = STORE.get(pid)
        STORE.delete(pid)
        _patch_dupes(old, None, old_rev)
        return True

    await _offload(_work)
    return _json({"deleted": True, "id": pid})


@_route("post", "/usage", op="recordUsage",
        summary="Count one run of a saved prompt.",
        body=schemas.UsageBody, returns=schemas.UsageResponse)
async def usage(request):
    data = await _body(request)
    pid = _str(data.get("id"))
    body = data.get("body")
    rec = await _offload(STORE.record_usage, pid,
                         _str(body) if body is not None else None)
    return _json({"prompt": rec, "counted": rec is not None})


@_route("post", "/merge", op="mergePrompts",
        summary="Merge `loser` into `winner` and delete the loser.",
        body=schemas.MergeBody, returns=schemas.PromptResponse)
async def merge(request):
    data = await _body(request)
    winner = _str(data.get("winner") or data.get("winner_id"))
    loser = _str(data.get("loser") or data.get("loser_id"))
    return _json(await _offload(lambda: _labelled(STORE.merge(winner, loser))))


@_route("post", "/merge_new", op="mergeIntoNewPrompt",
        summary="Create a third record absorbing both inputs, then delete both.",
        body=schemas.MergeNewBody, returns=schemas.PromptResponse)
async def merge_new(request):
    data = await _body(request)
    return _json(await _offload(lambda: _labelled(STORE.merge_new(
        _str(data.get("a") or data.get("a_id")),
        _str(data.get("b") or data.get("b_id")),
        _str(data.get("body")),
    ))))
