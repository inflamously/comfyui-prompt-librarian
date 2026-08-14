"""One function per feature — the ``/prompt_librarian/*`` handlers themselves.

Everything mechanical lives in :mod:`.utils`; everything constant lives in
:mod:`.config`; startup wiring lives in :mod:`.registration`. What is left here
is the use-case layer: what each endpoint reads, what it writes, and what it
hands back. Read top to bottom it is index maintenance, the two shared search
helpers, then GET, POST-reads and POST-writes in that order, with
:func:`handlers` at the end.

Every ``@_route`` names its contract: an ``op`` (the OpenAPI operation id —
stable, and what a generated client's method is called), a one-line summary,
and the :mod:`.schemas` dataclasses for the query, the body and the response.
None of it is read at runtime; ``scripts/openapi.py`` is what turns it into a
spec. The types are one import away, so "what does this endpoint take?" is
answerable from the handler without reading its body.

``_notify`` websocket events are emitted by the store itself; nothing here
duplicates them.
"""

import asyncio
import logging

from .. import dedupe, search, wildcards
from ..store import SCHEMA_VERSION, STORE, NotFoundError
from . import schemas
from .config import BULK_QUERY_LIMIT, CAPABILITIES
from .utils import (
    _ROUTES,
    _body,
    _bool,
    _ignored,
    _int,
    _json,
    _list,
    _offload,
    _opt,
    _query,
    _rev,
    _route,
    _str,
    _threshold,
)

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Index maintenance
# --------------------------------------------------------------------------- #
# Both caches are rev-keyed (search on `rev`, dedupe on `(rev, threshold, ...)`)
# so a bumped rev is already a guaranteed miss and *stale data is structurally
# impossible*. What follows is memory hygiene plus the incremental fast path:
# `dedupe.patch()` re-keys an all-pairs result onto the new rev for ~20 ms
# instead of the 0.5-2 s a cold rebuild costs.

_SINGLE_RECORD_OPS = frozenset(("create", "update", "delete", "usage"))


def _on_change(op, ids, records):
    """Store listener wired once at registration. Must never raise."""
    try:
        search.invalidate_index()
        if op not in _SINGLE_RECORD_OPS:
            # Bulk / merge / import / taxonomy edits touch too much to patch.
            dedupe.invalidate()
    except Exception:  # pragma: no cover - a broken index must not fail a write
        log.debug("[prompt-librarian] index invalidation failed", exc_info=True)


def _patch_dupes(old_rec, new_rec, old_rev):
    """Incrementally re-key the all-pairs cache after a single-record write."""
    try:
        result = dedupe.patch(old_rec, new_rec, _threshold(None),
                              old_rev=old_rev, new_rev=_rev(), source=STORE)
        if result is None:
            dedupe.invalidate()
    except Exception:  # pragma: no cover - fall back to the safe path
        log.debug("[prompt-librarian] dupe patch failed; invalidating", exc_info=True)
        dedupe.invalidate()


# --------------------------------------------------------------------------- #
# Search
# --------------------------------------------------------------------------- #

def _run_search(params, limit=None):
    """Run one search from a params mapping (query string or JSON body).

    ``match_id`` turns on the ``match_pct`` badge: similarity of every hit on
    the page to that record. It is derived from ``find_similar`` (one cached
    one-vs-N pass), so rows below the threshold simply carry no badge —
    which is what the panel wants, since a sub-threshold percentage is noise.
    """
    rev = _rev()
    threshold = _threshold(params.get("threshold"))
    ignored = _ignored()

    query = _str(params.get("q") or params.get("query") or "")
    category = params.get("category")
    category = _str(category) if category not in (None, "") else None
    tags = _list(params.get("tags"))
    dupes_only = _bool(params.get("dupes_only"))
    sort = _str(params.get("sort") or "relevance")
    mode = _str(params.get("mode") or "all")
    offset = _int(params.get("offset"), 0)
    page = _int(params.get("limit"), 50) if limit is None else limit
    match_id = _str(params.get("match_id") or "")

    ids = None
    if dupes_only:
        # `dupes_only` is the one search path that needs the all-pairs scan.
        ids = dedupe.dupe_ids(dedupe.dupe_counts(STORE, threshold, rev=rev,
                                                 ignored=ignored))

    def _counts(pids):
        return dedupe.page_dupe_counts(STORE, pids, threshold,
                                       ignored=ignored, rev=rev)

    match_fn = None
    if match_id:
        def _matches(pids):
            hits = dedupe.find_similar(STORE, pid=match_id, exclude_id=match_id,
                                       threshold=threshold, limit=0,
                                       with_summary=False, ignored=ignored, rev=rev)
            table = {hit["id"]: hit["score"] for hit in hits}
            return {pid: table[pid] for pid in pids if pid in table}
        match_fn = _matches

    return search.search(
        STORE, query,
        category=category, tags=tags, dupes_only=dupes_only,
        sort=sort, mode=mode, offset=offset, limit=page,
        threshold=threshold, rev=rev, dupe_ids=ids,
        dupe_count_fn=_counts, match_fn=match_fn,
    )


def _resolve_ids(data):
    """Ids for a bulk op: explicit ``ids``, or every hit of a stored ``query``.

    "Select all filtered" over 1 284 prompts must not ship 1 284 ids through
    the browser, so the frontend stores the *query* instead and the server
    re-runs it. Runs inside the executor with the mutation it feeds.
    """
    ids = data.get("ids")
    if isinstance(ids, (list, tuple)) and ids:
        return [_str(pid) for pid in ids if _str(pid)]
    query = data.get("query")
    if isinstance(query, dict):
        result = _run_search(query, limit=BULK_QUERY_LIMIT)
        return [hit["id"] for hit in result.get("hits", [])]
    return []


# --------------------------------------------------------------------------- #
# GET
# --------------------------------------------------------------------------- #

@_route("get", "/ping", op="ping",
        summary="Store facts the panel boots from: schema, count, flags, capabilities.",
        returns=schemas.PingResponse)
async def ping(request):
    return _json({
        "ok": True,
        "schema": SCHEMA_VERSION,
        "count": STORE.count(),
        "path": STORE.store_path(),
        "corrupt": STORE.is_corrupt(),
        "readonly": STORE.is_readonly(),
        "threshold": _threshold(None),
        "capabilities": dict(CAPABILITIES),
    })


@_route("get", "/search", op="searchPrompts",
        summary="Filter, sort, page and badge the library.",
        query=schemas.SearchQuery, returns=schemas.SearchResponse)
async def search_route(request):
    params = _query(request)
    if _bool(params.get("dupes_only")):
        # The only search shape that pays the all-pairs cost, so it is the only
        # one that leaves the event loop.
        return _json(await _offload(_run_search, params))
    return _json(_run_search(params))


@_route("get", "/prompt", op="getPrompt",
        summary="One full record, body included.",
        query=schemas.GetPromptQuery, returns=schemas.PromptResponse)
async def prompt(request):
    pid = _str(_query(request).get("id"))
    rec = STORE.get(pid)
    if rec is None:
        raise NotFoundError(f"no prompt with id {pid!r}")
    return _json({"prompt": rec})


@_route("get", "/versions", op="listVersions",
        summary="Version history of one record as previews, never full bodies.",
        query=schemas.ListVersionsQuery, returns=schemas.VersionsResponse)
async def versions(request):
    params = _query(request)
    pid = _str(params.get("id"))
    chars = _int(params.get("chars"), 160)
    # Previews only: a record at the 50-version cap would otherwise be a
    # multi-megabyte response on every selection change.
    return _json({"id": pid, "versions": STORE.version_previews(pid, chars)})


@_route("get", "/version", op="getVersion",
        summary="One full version entry by index.",
        query=schemas.GetVersionQuery, returns=schemas.VersionResponse)
async def version(request):
    params = _query(request)
    pid = _str(params.get("id"))
    index = _int(params.get("index"), -1)
    return _json({"id": pid, "index": index, "version": STORE.version(pid, index)})


@_route("get", "/taxonomy", op="getTaxonomy",
        summary="Everything the filter rail needs: categories with counts, and tags.",
        returns=schemas.TaxonomyResponse)
async def taxonomy(request):
    return _json(STORE.taxonomy())


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


@_route("get", "/snippets", op="listSnippets",
        summary="Every `[[snippet]]` body, keyed by name.",
        returns=schemas.SnippetsResponse)
async def snippets(request):
    return _json({"snippets": STORE.snippets()})


@_route("get", "/export", op="exportLibrary",
        summary="The whole library envelope, ready to write to a file.",
        returns=schemas.ExportResponse)
async def export(request):
    return _json({"library": await _offload(STORE.export_raw)})


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


# --------------------------------------------------------------------------- #
# POST — reads
# --------------------------------------------------------------------------- #

@_route("post", "/meta", op="getPromptMeta",
        body=schemas.MetaBody, returns=schemas.MetaResponse)
async def meta(request):
    """Batch metadata for node faces. Ten Librarian nodes = one request."""
    data = await _body(request)
    ids = [_str(pid) for pid in (data.get("ids") or []) if _str(pid)]
    records = STORE.get_many(ids)
    counts = dedupe.page_dupe_counts(STORE, list(records), _threshold(data.get("threshold")),
                                     ignored=_ignored(), rev=_rev())
    out = {}
    for pid, rec in records.items():
        out[pid] = {
            "name": rec.get("name", ""),
            "rating": int(rec.get("rating", 0) or 0),
            "used": int(rec.get("used", 0) or 0),
            "category": rec.get("category", ""),
            "tags": list(rec.get("tags") or ()),
            "near_dupes": int(counts.get(pid, 0) or 0),
            "updated": rec.get("updated", ""),
        }
    return _json({"meta": out})


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


# --------------------------------------------------------------------------- #
# POST — writes (all offloaded)
# --------------------------------------------------------------------------- #

@_route("post", "/create", op="createPrompt",
        summary="Create a record and return it.",
        body=schemas.CreateBody, returns=schemas.PromptResponse)
async def create(request):
    data = await _body(request)

    def _work():
        old_rev = _rev()
        rec = STORE.create(
            name=_str(data.get("name")),
            body=_str(data.get("body")),
            category=_str(data.get("category")),
            tags=_list(data.get("tags")),
            rating=_int(data.get("rating"), 0),
            notes=_str(data.get("notes")),
            pinned=_bool(data.get("pinned")),
        )
        _patch_dupes(None, rec, old_rev)
        return rec

    return _json({"prompt": await _offload(_work)})


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
            name=_opt(data, "name"),
            body=_opt(data, "body"),
            category=_opt(data, "category"),
            tags=(_list(data.get("tags")) if "tags" in data else None),
            rating=(_int(data.get("rating"), 0) if "rating" in data else None),
            notes=_opt(data, "notes"),
            pinned=(_bool(data.get("pinned")) if "pinned" in data else None),
            snapshot=_bool(data.get("snapshot"), True),
            # The half of "never a silent overwrite" that covers two tabs
            # editing the same record: a mismatch raises ConflictError -> 409.
            expect_updated=_opt(data, "expect_updated"),
        )
        _patch_dupes(old, rec, old_rev)
        return rec

    return _json({"prompt": await _offload(_work)})


@_route("post", "/rate", op="ratePrompt",
        summary="Set a record's 0-5 rating.",
        body=schemas.RateBody, returns=schemas.PromptResponse)
async def rate(request):
    data = await _body(request)
    pid = _str(data.get("id"))
    rating = _int(data.get("rating"), 0)
    return _json({"prompt": await _offload(STORE.set_rating, pid, rating)})


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


@_route("post", "/bulk/categorize", op="bulkCategorizePrompts",
        summary="Move the whole selection into one category.",
        body=schemas.BulkCategorizeBody, returns=schemas.BulkCountResponse)
async def bulk_categorize(request):
    data = await _body(request)

    def _work():
        ids = _resolve_ids(data)
        return ids, STORE.bulk_categorize(ids, _str(data.get("category")))

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


@_route("post", "/merge", op="mergePrompts",
        summary="Merge `loser` into `winner` and delete the loser.",
        body=schemas.MergeBody, returns=schemas.PromptResponse)
async def merge(request):
    data = await _body(request)
    winner = _str(data.get("winner") or data.get("winner_id"))
    loser = _str(data.get("loser") or data.get("loser_id"))
    return _json({"prompt": await _offload(STORE.merge, winner, loser)})


@_route("post", "/merge_new", op="mergeIntoNewPrompt",
        summary="Create a third record absorbing both inputs, then delete both.",
        body=schemas.MergeNewBody, returns=schemas.PromptResponse)
async def merge_new(request):
    data = await _body(request)
    return _json({"prompt": await _offload(
        STORE.merge_new,
        _str(data.get("a") or data.get("a_id")),
        _str(data.get("b") or data.get("b_id")),
        _str(data.get("body")),
        _str(data.get("name")),
    )})


@_route("post", "/versions/restore", op="restoreVersion",
        summary="Restore a version onto the record; the current body is snapshotted first.",
        body=schemas.RestoreVersionBody, returns=schemas.PromptResponse)
async def versions_restore(request):
    data = await _body(request)
    pid = _str(data.get("id"))
    index = _int(data.get("index"), -1)
    # Snapshots the current body first, so the restore is itself undoable.
    return _json({"prompt": await _offload(STORE.restore_version, pid, index)})


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


@_route("post", "/category", op="editCategory",
        summary="Add, rename or delete a category.",
        body=schemas.CategoryBody, returns=schemas.CategoryResponse)
async def category(request):
    data = await _body(request)
    op = _str(data.get("op") or "add").strip().lower()
    name = _str(data.get("name"))

    def _work():
        if op == "add":
            return 0, STORE.add_category(name)
        if op == "rename":
            count = STORE.rename_category(name, _str(data.get("new")))
            return count, STORE.categories()
        if op == "delete":
            count = STORE.delete_category(name, _str(data.get("reassign_to")))
            return count, STORE.categories()
        raise ValueError(f"unknown category op {op!r}")

    count, names = await _offload(_work)
    return _json({"count": count, "categories": names})


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


@_route("post", "/settings", op="updateSettings",
        body=schemas.SettingsBody, returns=schemas.SettingsResponse)
async def settings(request):
    """Persist the dupe threshold / version cap the panel exposes."""
    data = await _body(request)
    return _json({"settings": await _offload(
        STORE.set_settings,
        _opt(data, "dupe_threshold"),
        _opt(data, "version_cap"),
    )})


@_route("post", "/import", op="importLibrary",
        summary="Import an envelope.",
        body=schemas.ImportBody, returns=schemas.ImportResponse)
async def import_route(request):
    data = await _body(request)
    raw = data.get("library", data.get("raw"))
    replace = _bool(data.get("replace"), True)
    return _json({"count": await _offload(STORE.import_raw, raw, replace)})


# --------------------------------------------------------------------------- #
# The route table
# --------------------------------------------------------------------------- #

def handlers():
    """``{(method, path): handler}`` without touching aiohttp or the store."""
    return {(route.method, route.path): route.handler for route in _ROUTES}
