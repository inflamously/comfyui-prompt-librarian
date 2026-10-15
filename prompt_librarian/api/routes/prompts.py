"""Record routes: get, meta, create, update, rate, delete, usage and merge."""

from ... import app
from ...features.prompts.create import create_prompt
from ...features.prompts.delete import delete_prompt
from ...features.prompts.get import get_prompt
from ...features.prompts.merge import merge_into_new, merge_prompts
from ...features.prompts.update import rate_prompt, update_prompt
from ...features.prompts.usage import record_usage
from ...shared.errors import NotFoundError
from .. import schemas
from ..utils import (
    _body,
    _bool,
    _int,
    _json,
    _labelled,
    _lib,
    _list,
    _offload,
    _opt,
    _query,
    _route,
    _str,
    _threshold,
)


@_route("get", "/prompt", op="getPrompt",
        summary="One full record, body included.",
        query=schemas.GetPromptQuery, returns=schemas.PromptResponse)
async def prompt(request):
    pid = _str(_query(request).get("id"))
    rec = get_prompt(_lib(), pid)
    if rec is None:
        raise NotFoundError(f"no prompt with id {pid!r}")
    return _json(_labelled(rec))


@_route("post", "/meta", op="getPromptMeta",
        body=schemas.MetaBody, returns=schemas.MetaResponse)
async def meta(request):
    """Batch metadata for node faces. Ten Librarian nodes = one request."""
    data = await _body(request)
    ids = [_str(pid) for pid in (data.get("ids") or []) if _str(pid)]
    return _json({"meta": app.prompt_meta(app.current(), ids, _threshold(data.get("threshold")))})


@_route("post", "/create", op="createPrompt",
        summary="Create a record and return it.",
        body=schemas.CreateBody, returns=schemas.PromptResponse)
async def create(request):
    data = await _body(request)

    def _work():
        rec = create_prompt(
            _lib(),
            body=_str(data.get("body")),
            tags=_list(data.get("tags")),
            rating=_int(data.get("rating"), 0),
            notes=_str(data.get("notes")),
            pinned=_bool(data.get("pinned")),
        )
        return _labelled(rec)

    return _json(await _offload(_work))


@_route("post", "/update", op="updatePrompt",
        summary="Partial update; omitted fields are left alone.",
        body=schemas.UpdateBody, returns=schemas.PromptResponse)
async def update(request):
    data = await _body(request)
    pid = _str(data.get("id"))

    def _work():
        rec = update_prompt(
            _lib(),
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
        return _labelled(rec)

    return _json(await _offload(_work))


@_route("post", "/rate", op="ratePrompt",
        summary="Set a record's 0-5 rating.",
        body=schemas.RateBody, returns=schemas.PromptResponse)
async def rate(request):
    data = await _body(request)
    pid = _str(data.get("id"))
    rating = _int(data.get("rating"), 0)

    def _work():
        rec = rate_prompt(_lib(), pid, rating)
        return _labelled(rec)

    return _json(await _offload(_work))


@_route("post", "/delete", op="deletePrompt",
        summary="Delete a record outright — there is no trash bin.",
        body=schemas.PromptIdBody, returns=schemas.DeleteResponse)
async def delete(request):
    data = await _body(request)
    pid = _str(data.get("id"))

    def _work():
        delete_prompt(_lib(), pid)
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
    rec = await _offload(record_usage, _lib(), pid,
                         _str(body) if body is not None else None)
    return _json({"prompt": rec, "counted": rec is not None})


@_route("post", "/merge", op="mergePrompts",
        summary="Merge `loser` into `winner` and delete the loser.",
        body=schemas.MergeBody, returns=schemas.PromptResponse)
async def merge(request):
    data = await _body(request)
    winner = _str(data.get("winner") or data.get("winner_id"))
    loser = _str(data.get("loser") or data.get("loser_id"))
    return _json(await _offload(lambda: _labelled(merge_prompts(_lib(), winner, loser))))


@_route("post", "/merge_new", op="mergeIntoNewPrompt",
        summary="Create a third record absorbing both inputs, then delete both.",
        body=schemas.MergeNewBody, returns=schemas.PromptResponse)
async def merge_new(request):
    data = await _body(request)
    return _json(await _offload(lambda: _labelled(merge_into_new(
        _lib(),
        _str(data.get("a") or data.get("a_id")),
        _str(data.get("b") or data.get("b_id")),
        _str(data.get("body")),
    ))))
