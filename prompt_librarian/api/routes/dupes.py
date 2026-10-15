"""Offload/coalesce library-wide scans; cached one-body checks run inline."""

from ... import app
from ...features import dupes as dupes_feature
from ...features.library.ignored import ignore_pair, unignore_pair
from ...features.prompts.get import get_prompt
from ...shared.errors import NotFoundError
from .. import schemas
from ..queries import _all_pairs
from ..utils import (
    _body,
    _bool,
    _ignored,
    _int,
    _json,
    _lib,
    _offload,
    _query,
    _route,
    _str,
    _threshold,
)


@_route("get", "/dupes/all", op="listAllDupes",
        summary="Library-wide near-duplicate scan: per-record counts, groups and pairs.",
        query=schemas.DupesAllQuery, returns=schemas.DupesAllResponse)
async def dupes_all(request):
    params = _query(request)
    result = await _all_pairs(_threshold(params.get("threshold")),
                              _bool(params.get("exhaustive")))
    return _json({
        "threshold": result.get("threshold"),
        "exhaustive": result.get("exhaustive"),
        "counts": result.get("counts", {}),
        "groups": result.get("groups", []),
        "pairs": result.get("pairs", {}),
        "ignored": [list(pair) for pair in _ignored()],
    })


@_route("post", "/dupes", op="findSimilar",
        summary="One-vs-N near-duplicate check for one body against the library.",
        body=schemas.DupesBody, returns=schemas.DupesResponse)
async def dupes(request):
    """One-vs-N near-duplicate check, run inline: cached it beats an executor hop."""
    data = await _body(request)
    threshold = _threshold(data.get("threshold"))
    text = data.get("text")
    pid = _str(data.get("id")) or None
    # Required, or saving an existing prompt always reports itself at 100%.
    exclude_id = _str(data.get("exclude_id")) or None
    matches = app.similar_prompts(
        app.current(),
        text=(_str(text) if text is not None else None),
        pid=pid,
        exclude_id=exclude_id,
        threshold=threshold,
        limit=_int(data.get("limit"), 10),
        with_summary=_bool(data.get("summaries"), True),
        ignored=_ignored(),
    )
    return _json({"matches": matches, "threshold": threshold})


@_route("post", "/compare", op="compareBodies",
        summary="Word-level diff of two bodies.",
        body=schemas.CompareBody, returns=schemas.CompareResponse)
async def compare(request):
    """Word-level diff of two bodies, each given as an id or as raw text."""
    data = await _body(request)
    return _json(dupes_feature.compare(_side(data, "a"), _side(data, "b")))


def _side(data, key):
    text = data.get(key + "_text")
    if text is not None:
        return _str(text)
    pid = _str(data.get(key + "_id") or data.get(key))
    rec = get_prompt(_lib(), pid)
    if rec is None:
        raise NotFoundError(f"no prompt with id {pid!r}")
    return rec.get("body", "")


@_route("post", "/dupes/ignore", op="ignoreDupePair",
        summary="Record (or undo) a \"keep both\" decision so dedupe stops nagging.",
        body=schemas.IgnoreDupeBody, returns=schemas.IgnoreDupeResponse)
async def dupes_ignore(request):
    """Record (or undo) a "keep both" decision so dedupe stops nagging."""
    data = await _body(request)
    first = _str(data.get("a") or data.get("id"))
    second = _str(data.get("b") or data.get("other"))
    if _bool(data.get("unignore")):
        changed = await _offload(unignore_pair, _lib(), first, second)
        return _json({"changed": bool(changed), "ignored": False})
    changed = await _offload(ignore_pair, _lib(), first, second)
    return _json({"changed": bool(changed), "ignored": True})
