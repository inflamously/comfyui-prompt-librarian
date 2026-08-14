"""Near-duplicate detection in all three shapes, plus "keep both".

* ``/dupes/all`` — the library-wide all-pairs scan. Expensive (0.5-2 s cold),
  offloaded, and coalesced (see :func:`_dupes_all`).
* ``/dupes`` — one body against the library. The hot path, fired on every
  edit, and cheap enough to run inline.
* ``/compare`` — two bodies, word-level diff.
* ``/dupes/ignore`` — the decision that stops the other three from nagging.
"""

import asyncio

from ... import dedupe
from ...store import STORE, NotFoundError
from .. import schemas
from ..utils import (
    _body,
    _bool,
    _ignored,
    _int,
    _json,
    _offload,
    _query,
    _rev,
    _route,
    _str,
    _threshold,
)


@_route("get", "/dupes/all", op="listAllDupes",
        summary="Library-wide near-duplicate scan: per-record counts, groups and pairs.",
        query=schemas.DupesAllQuery, returns=schemas.DupesAllResponse)
async def dupes_all(request):
    params = _query(request)
    result = await _dupes_all(_threshold(params.get("threshold")),
                              _bool(params.get("exhaustive")))
    return _json({
        "threshold": result.get("threshold"),
        "exhaustive": result.get("exhaustive"),
        "counts": result.get("counts", {}),
        "groups": result.get("groups", []),
        "pairs": result.get("pairs", {}),
    })


# -- /dupes/all coalescing --------------------------------------------------- #
# Concurrent callers on the same (rev, threshold, exhaustive) await one
# computation instead of stampeding the executor with n identical 0.5-2 s
# scans. The dict is only ever touched from the event loop, so it needs no lock.

_all_inflight = {}


async def _dupes_all(threshold, exhaustive):
    # `ignored_pairs()` calls `ensure_loaded()`, which bumps `rev` when the file
    # changed underneath us. Do it *before* computing the key, or the leader can
    # register under a rev that later callers no longer compute — which silently
    # un-coalesces the stampede this function exists to prevent.
    ignored = _ignored()
    key = (_rev(), float(threshold), bool(exhaustive))
    entry = _all_inflight.get(key)
    if entry is not None:
        event, box = entry
        await event.wait()
        if "error" in box:
            raise box["error"]
        if "result" in box:
            return box["result"]
        # The leader vanished without a result; fall through and compute.
    event = asyncio.Event()
    box = {}
    _all_inflight[key] = (event, box)
    # Publish the marker, then yield once before starting the work. Under
    # eagerly-started tasks (3.12+ eager factories, 3.14's gather) a leader
    # whose executor future resolves without suspending would otherwise run to
    # completion — marker set *and* torn down — before a single peer got to
    # look, and the stampede this function prevents would happen anyway.
    await asyncio.sleep(0)
    try:
        box["result"] = await _offload(
            dedupe.dupe_counts, STORE, threshold,
            rev=key[0], exhaustive=exhaustive, ignored=ignored,
        )
    except Exception as exc:
        box["error"] = exc
        raise
    finally:
        _all_inflight.pop(key, None)
        event.set()
    return box["result"]


@_route("post", "/dupes", op="findSimilar",
        summary="One-vs-N near-duplicate check for one body against the library.",
        body=schemas.DupesBody, returns=schemas.DupesResponse)
async def dupes(request):
    """One-vs-N near-duplicate check — the hot path, fired on every edit.

    Runs inline: with the ``(sha1(normalized text), threshold, rev)`` cache a
    typical call is ~2 ms, and executor dispatch would cost more than the work.
    """
    data = await _body(request)
    threshold = _threshold(data.get("threshold"))
    text = data.get("text")
    pid = _str(data.get("id")) or None
    # Required, or saving an existing prompt always reports itself at 100%.
    exclude_id = _str(data.get("exclude_id")) or None
    matches = dedupe.find_similar(
        STORE,
        text=(_str(text) if text is not None else None),
        pid=pid,
        exclude_id=exclude_id,
        threshold=threshold,
        limit=_int(data.get("limit"), 10),
        with_summary=_bool(data.get("summaries"), True),
        ignored=_ignored(),
        rev=_rev(),
    )
    return _json({"matches": list(matches), "threshold": threshold})


@_route("post", "/compare", op="compareBodies",
        summary="Word-level diff of two bodies.",
        body=schemas.CompareBody, returns=schemas.CompareResponse)
async def compare(request):
    """Word-level diff of two bodies, each given as an id or as raw text."""
    data = await _body(request)
    return _json(dedupe.compare(_side(data, "a"), _side(data, "b")))


def _side(data, key):
    text = data.get(key + "_text")
    if text is not None:
        return _str(text)
    pid = _str(data.get(key + "_id") or data.get(key))
    rec = STORE.get(pid)
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
        changed = await _offload(STORE.unignore_pair, first, second)
        return _json({"changed": bool(changed), "ignored": False})
    changed = await _offload(STORE.ignore_pair, first, second)
    return _json({"changed": bool(changed), "ignored": True})
