"""Tests for ``prompt_librarian.api``.

The handlers are driven directly with a stub request (``.rel_url.query`` plus
an async ``.json()``), so no aiohttp server is stood up — only
``web.json_response`` is needed, and the whole module skips if aiohttp is not
installed in this sandbox.
"""

import asyncio
import json
import sys
import types

import pytest

pytest.importorskip("aiohttp")

from prompt_librarian import api, dedupe, search  # noqa: E402
from prompt_librarian import store as librarian_store  # noqa: E402

# --------------------------------------------------------------------------- #
# Harness
# --------------------------------------------------------------------------- #

class FakeRoutes:
    """Enough of aiohttp's RouteTableDef for ``register()``."""

    def __init__(self):
        self.table = {}

    def _add(self, method, path):
        def _deco(handler):
            self.table[(method, path)] = handler
            return handler
        return _deco

    def get(self, path):
        return self._add("get", path)

    def post(self, path):
        return self._add("post", path)


class Request:
    """A stub aiohttp request: query params and a JSON body."""

    def __init__(self, query=None, body=None):
        self.rel_url = types.SimpleNamespace(query=dict(query or {}))
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no json body")
        return self._body


@pytest.fixture(scope="module")
def routes():
    table = FakeRoutes()
    api.register(table)
    return table


def _modules_binding_store():
    """Every api module that did ``from ...store import STORE``.

    ``STORE`` is a module-level singleton each module imports *by name*, so
    every binding has to be replaced independently — patching only some would
    leave part of the route layer talking to the process-wide store. Discovered
    rather than listed, so a new route module cannot silently opt out of the
    swap and start writing to the real library.
    """
    return [
        module for name, module in sorted(sys.modules.items())
        if name.startswith("prompt_librarian.api")
        and getattr(module, "STORE", None) is librarian_store.STORE
    ]


@pytest.fixture
def store(tmp_path, monkeypatch, routes):
    """A real store in a temp dir, swapped into every api module that binds it."""
    target = librarian_store.LibrarianStore(path=str(tmp_path / "lib" / "library.json"))
    modules = _modules_binding_store()
    # A silent empty list here would point the handlers at the user's real
    # library.json, so assert the two ends of the layering were found.
    assert api.utils in modules
    assert api.routes.prompts in modules
    for module in modules:
        monkeypatch.setattr(module, "STORE", target)
    # id(store)-keyed caches must not survive between tests: CPython can hand a
    # new object the address of a collected one.
    search.invalidate_index()
    dedupe.invalidate()
    return target


@pytest.fixture
def call(routes):
    def _call(method, path, query=None, body=None):
        handler = routes.table[(method, api.PREFIX + path)]
        response = asyncio.run(handler(Request(query, body)))
        return response.status, json.loads(response.body.decode("utf-8"))
    return _call


def ok(result):
    status, payload = result
    assert status == 200, payload
    assert "rev" in payload
    return payload


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #

def test_every_route_is_registered(routes):
    assert routes.table
    for (method, path) in routes.table:
        assert method in ("get", "post")
        assert path.startswith(api.PREFIX + "/")


def test_reads_are_get_and_writes_are_post(routes):
    methods = {path: method for (method, path) in routes.table}
    assert methods[api.PREFIX + "/search"] == "get"
    assert methods[api.PREFIX + "/create"] == "post"
    assert methods[api.PREFIX + "/bulk/delete"] == "post"


def test_register_returns_the_handler_map(routes):
    table = api.register(routes)
    assert table == routes.table == api.handlers()


# --------------------------------------------------------------------------- #
# GET
# --------------------------------------------------------------------------- #

def test_ping(call, store):
    payload = ok(call("get", "/ping"))
    assert payload["ok"] is True
    assert payload["schema"] == librarian_store.SCHEMA_VERSION
    assert payload["count"] == 0
    assert payload["corrupt"] is False
    assert payload["readonly"] is False
    assert 0.0 <= payload["threshold"] <= 1.0
    assert payload["path"].endswith("library.json")
    caps = payload["capabilities"]
    assert caps["soft_delete"] is False
    for name in ("search", "versions", "diff", "wildcards", "snippets",
                 "bulk", "dupes"):
        assert caps[name] is True


def test_search_empty_library(call, store):
    payload = ok(call("get", "/search", {"q": ""}))
    assert payload["total"] == 0
    assert payload["hits"] == []


def test_search_finds_and_shapes_hits(call, store):
    store.create(body="make him dance ballet slowly",
                 tags=["dance"])
    store.create(body="a completely different thing")
    payload = ok(call("get", "/search", {"q": "ballet"}))
    assert payload["total"] == 1
    hit = payload["hits"][0]
    for key in ("id", "label", "preview", "tags", "rating", "used",
                "updated", "chars", "version_count", "score", "dupe_count",
                "match_pct"):
        assert key in hit
    # Derived from the corpus: "ballet" is the term this body has and the
    # other one does not.
    assert "ballet" in hit["label"]


def test_search_filters_and_paginates(call, store):
    for index in range(5):
        store.create(body=f"body {index}", tags=["c"])
    payload = ok(call("get", "/search", {"tags": "c", "limit": "2",
                                         "offset": "1", "sort": "az"}))
    assert payload["total"] == 5
    assert len(payload["hits"]) == 2
    assert payload["offset"] == 1


def test_search_dupes_only(call, store):
    store.create(body="make him dance ballet drifting toward the camera")
    store.create(body="make him dance ballet drifting towards the camera")
    store.create(body="totally unrelated subject matter here")
    payload = ok(call("get", "/search", {"dupes_only": "1"}))
    assert payload["total"] == 2
    assert payload["dupes_partial"] is False
    assert all(hit["dupe_count"] >= 1 for hit in payload["hits"])


def test_search_match_id_populates_match_pct(call, store):
    first = store.create(body="make him dance ballet toward the camera")
    store.create(body="make him dance ballet towards the camera")
    payload = ok(call("get", "/search", {"match_id": first["id"]}))
    pcts = {hit["id"]: hit["match_pct"] for hit in payload["hits"]}
    other = next(pid for pid in pcts if pid != first["id"])
    assert pcts[other] is not None and pcts[other] >= 90
    assert pcts[first["id"]] is None    # excluded from its own match map


def test_prompt(call, store):
    rec = store.create(body="b")
    payload = ok(call("get", "/prompt", {"id": rec["id"]}))
    assert payload["prompt"]["id"] == rec["id"]


def test_every_single_record_response_carries_a_label(call, store):
    """The label rides BESIDE the record, never inside it.

    Inside, it would be written to the file by `/export` -> `/import`, which is
    a stored name again by another route.
    """
    store.create(body="a bowl of fruit on a wooden table")
    rec = store.create(body="a lone ballerina in a ruined theatre")
    pid = rec["id"]

    reads = [call("get", "/prompt", {"id": pid})]
    writes = [
        call("post", "/create", body={"body": "neon rain over tokyo rooftops"}),
        call("post", "/update", body={"id": pid, "body": "a lone ballerina, ruined stage"}),
        call("post", "/rate", body={"id": pid, "rating": 4}),
    ]
    for result in reads + writes:
        payload = ok(result)
        assert payload["label"], payload
        assert "name" not in payload["prompt"]
        assert "label" not in payload["prompt"]


def test_the_label_is_derived_from_the_corpus_not_the_body_head(call, store):
    """Two prompts opening identically still read apart."""
    first = store.create(body="a lone ballerina drifting through a ruined theatre")
    second = store.create(body="a lone ballerina drifting through a sunlit field")
    a = ok(call("get", "/prompt", {"id": first["id"]}))["label"]
    b = ok(call("get", "/prompt", {"id": second["id"]}))["label"]
    assert a != b
    assert "ruined" in a and "sunlit" in b


def test_a_label_moves_when_the_library_around_it_does(call, store):
    """It is derived, and derived from the *corpus* — so it is not stable and
    nothing may key off it. Saving an unrelated prompt that happens to share
    these words is enough to change what this one is called."""
    rec = store.create(body="a lone ballerina drifting through a ruined theatre at dusk")
    before = ok(call("get", "/prompt", {"id": rec["id"]}))["label"]
    assert "ballerina" in before

    ok(call("post", "/create", body={"body": "a lone ballerina drifting slowly"}))
    after = ok(call("get", "/prompt", {"id": rec["id"]}))["label"]
    assert after != before
    # "ballerina" is no longer this record's alone, so what is left of it is.
    assert "ballerina" not in after
    assert "ruined theatre" in after


def test_prompt_unknown_id_is_404(call, store):
    status, payload = call("get", "/prompt", {"id": "nope"})
    assert status == 404
    assert payload["code"] == "not_found"
    assert "rev" in payload


def test_versions_and_version(call, store):
    rec = store.create(body="first")
    store.update(rec["id"], body="second")
    payload = ok(call("get", "/versions", {"id": rec["id"]}))
    assert len(payload["versions"]) == 1
    entry = payload["versions"][0]
    assert set(entry) == {"index", "label", "ts", "src", "chars", "preview"}
    assert "body" not in entry            # previews only, never full bodies
    assert entry["label"]                 # derived from the snapshotted body

    full = ok(call("get", "/version", {"id": rec["id"], "index": "0"}))
    assert full["version"]["body"] == "first"


def test_version_bad_index_is_404(call, store):
    rec = store.create(body="b")
    status, payload = call("get", "/version", {"id": rec["id"], "index": "9"})
    assert status == 404
    assert payload["code"] == "not_found"


def test_taxonomy(call, store):
    store.create(body="x", tags=["t1", "t2"])
    payload = ok(call("get", "/taxonomy"))
    assert payload["total"] == 1
    assert {t["tag"] for t in payload["tags"]} == {"t1", "t2"}


def test_dupes_all(call, store):
    first = store.create(body="make him dance ballet toward the camera")
    second = store.create(body="make him dance ballet towards the camera")
    payload = ok(call("get", "/dupes/all"))
    assert payload["counts"][first["id"]] == 1
    assert payload["counts"][second["id"]] == 1
    assert sorted(payload["groups"][0]) == sorted([first["id"], second["id"]])
    assert second["id"] in payload["pairs"][first["id"]]


def test_dupes_all_coalesces_concurrent_callers(call, store, monkeypatch):
    store.create(body="make him dance ballet toward the camera")
    store.create(body="make him dance ballet towards the camera")
    calls = []
    real = dedupe.dupe_counts

    def _counted(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(dedupe, "dupe_counts", _counted)

    async def _race():
        return await asyncio.gather(
            *[api.routes.dupes._dupes_all(0.9, False) for _ in range(5)])

    results = asyncio.run(_race())
    assert len(results) == 5
    assert len(calls) == 1


def test_wildcards(call, store, tmp_path, monkeypatch):
    from prompt_librarian import wildcards as wc
    root = tmp_path / "wc"
    root.mkdir()
    (root / "mood.txt").write_text("calm\ntense\n", encoding="utf-8")
    monkeypatch.setattr(wc, "FILES", wc.WildcardFiles(str(root)))
    payload = ok(call("get", "/wildcards"))
    assert payload["names"] == ["mood"]
    assert payload["signature"]
    assert payload["dir"] == str(root)


def test_snippets_and_export(call, store):
    store.set_snippet("cine", "volumetric haze")
    assert ok(call("get", "/snippets"))["snippets"]["cine"]["body"] == "volumetric haze"
    library = ok(call("get", "/export"))["library"]
    assert library["schema"] == librarian_store.SCHEMA_VERSION
    assert "prompts" in library


# --------------------------------------------------------------------------- #
# POST — CRUD
# --------------------------------------------------------------------------- #

def test_create(call, store):
    payload = ok(call("post", "/create", body={
        "body": "b",
        "tags": ["x", "y"], "rating": 3, "notes": "note", "pinned": True,
    }))
    rec = payload["prompt"]
    assert rec["body"] == "b" and rec["tags"] == ["x", "y"] and rec["rating"] == 3
    assert "name" not in rec
    assert store.count() == 1


def test_create_ignores_a_name_from_an_older_client(call, store):
    """The field is gone from the api, not merely unused by the panel."""
    payload = ok(call("post", "/create", body={"body": "b", "name": "n"}))
    assert "name" not in payload["prompt"]
    assert "name" not in store.all()[0]


def test_create_oversized_body_is_413(call, store):
    status, payload = call("post", "/create",
                           body={"body": "x" * (librarian_store.MAX_BODY_CHARS + 1)})
    assert status == 413
    assert payload["code"] == "too_large"
    assert store.count() == 0            # rejected before anything was written


def test_update(call, store):
    rec = store.create(body="one")
    payload = ok(call("post", "/update", body={"id": rec["id"], "body": "two"}))
    assert payload["prompt"]["body"] == "two"
    assert len(payload["prompt"]["versions"]) == 1


def test_update_partial_fields_only(call, store):
    rec = store.create(body="one", tags=["t"])
    payload = ok(call("post", "/update", body={"id": rec["id"], "rating": 5}))
    assert payload["prompt"]["body"] == "one"
    assert payload["prompt"]["tags"] == ["t"]
    assert payload["prompt"]["rating"] == 5


def test_update_expect_updated_conflict_is_409(call, store):
    rec = store.create(body="one")
    store.update(rec["id"], body="two")          # another tab got there first
    # `updated` is second-precision, so a same-second edit can collide; the
    # baseline the losing tab holds is explicitly older than any real stamp.
    status, payload = call("post", "/update", body={
        "id": rec["id"], "body": "three", "expect_updated": "1999-01-01T00:00:00Z",
    })
    assert status == 409
    assert payload["code"] == "conflict"
    assert store.get(rec["id"])["body"] == "two"  # never a silent overwrite


def test_update_expect_updated_matching_succeeds(call, store):
    rec = store.create(body="one")
    payload = ok(call("post", "/update", body={
        "id": rec["id"], "body": "two", "expect_updated": rec["updated"],
    }))
    assert payload["prompt"]["body"] == "two"


def test_update_unknown_id_is_404(call, store):
    status, payload = call("post", "/update", body={"id": "nope", "body": "x"})
    assert status == 404
    assert payload["code"] == "not_found"


def test_rate(call, store):
    rec = store.create(body="b")
    payload = ok(call("post", "/rate", body={"id": rec["id"], "rating": 4}))
    assert payload["prompt"]["rating"] == 4
    assert payload["prompt"]["versions"] == []   # rating never snapshots


def test_delete(call, store):
    rec = store.create(body="b")
    payload = ok(call("post", "/delete", body={"id": rec["id"]}))
    assert payload["deleted"] is True
    assert store.count() == 0


def test_usage(call, store):
    rec = store.create(body="body")
    payload = ok(call("post", "/usage", body={"id": rec["id"], "body": "body"}))
    assert payload["counted"] is True
    assert payload["prompt"]["used"] == 1

    payload = ok(call("post", "/usage", body={"id": rec["id"], "body": "edited"}))
    assert payload["counted"] is False
    assert payload["prompt"] is None


def test_meta(call, store):
    first = store.create(body="make him dance ballet toward the camera",
                         tags=["t"], rating=2)
    second = store.create(body="make him dance ballet towards the camera")
    payload = ok(call("post", "/meta", body={"ids": [first["id"], second["id"], "nope"]}))
    entry = payload["meta"][first["id"]]
    assert set(entry) == {"label", "rating", "used", "tags",
                          "near_dupes", "updated"}
    assert entry["label"]
    assert entry["near_dupes"] == 1
    assert "nope" not in payload["meta"]


def test_malformed_body_is_not_a_500(call, store):
    status, payload = call("post", "/meta", body=None)
    assert status == 200
    assert payload["meta"] == {}


# --------------------------------------------------------------------------- #
# POST — bulk (ids and query)
# --------------------------------------------------------------------------- #

@pytest.fixture
def five(store):
    return [store.create(body=f"body {i}", tags=["c"])
            for i in range(5)]


def test_bulk_delete_by_ids(call, store, five):
    ids = [rec["id"] for rec in five[:2]]
    payload = ok(call("post", "/bulk/delete", body={"ids": ids}))
    assert payload["count"] == 2
    assert store.count() == 3


def test_bulk_delete_by_query(call, store, five):
    # "select all filtered" ships the query, not 1 284 ids.
    payload = ok(call("post", "/bulk/delete", body={"query": {"tags": ["c"]}}))
    assert payload["count"] == 5
    assert len(payload["ids"]) == 5
    assert store.count() == 0


def test_bulk_retag_by_query(call, store, five):
    payload = ok(call("post", "/bulk/retag",
                      body={"query": {"q": "body"}, "add": ["tagged"]}))
    assert payload["count"] == 5
    assert all("tagged" in store.get(rec["id"])["tags"] for rec in five)


def test_bulk_retag_replace(call, store, five):
    ids = [rec["id"] for rec in five]
    ok(call("post", "/bulk/retag", body={"ids": ids, "add": ["a", "b"]}))
    ok(call("post", "/bulk/retag", body={"ids": ids, "replace": ["only"]}))
    assert store.get(ids[0])["tags"] == ["only"]


def test_bulk_merge(call, store):
    first = store.create(body="one", tags=["x"])
    second = store.create(body="two", tags=["y"])
    store.record_usage(second["id"], body="two")
    payload = ok(call("post", "/bulk/merge",
                      body={"ids": [first["id"], second["id"]], "winner": first["id"]}))
    rec = payload["prompt"]
    assert rec["id"] == first["id"]
    assert rec["tags"] == ["x", "y"]
    assert rec["used"] == 1
    assert store.count() == 1


def test_bulk_merge_needs_two_records(call, store):
    rec = store.create(body="one")
    status, payload = call("post", "/bulk/merge", body={"ids": [rec["id"]]})
    assert status == 400
    assert payload["code"] == "same_record"


def test_bulk_with_no_ids_is_a_noop(call, store, five):
    payload = ok(call("post", "/bulk/delete", body={}))
    assert payload["count"] == 0
    assert store.count() == 5


# --------------------------------------------------------------------------- #
# POST — dedupe / merge / versions
# --------------------------------------------------------------------------- #

def test_dupes_by_text(call, store):
    store.create(body="make him dance ballet drifting toward the camera")
    payload = ok(call("post", "/dupes", body={
        "text": "make him dance ballet drifting towards the camera",
    }))
    assert len(payload["matches"]) == 1
    match = payload["matches"][0]
    assert set(match) == {"id", "label", "score", "pct", "summary", "preview",
                          "used", "updated"}
    assert match["pct"] >= 90
    assert match["summary"]
    assert match["label"]


def test_dupes_excludes_self(call, store):
    rec = store.create(body="make him dance ballet toward the camera")
    payload = ok(call("post", "/dupes", body={"id": rec["id"],
                                              "exclude_id": rec["id"]}))
    assert payload["matches"] == []


def test_dupes_summaries_can_be_skipped(call, store):
    store.create(body="make him dance ballet drifting toward the camera")
    payload = ok(call("post", "/dupes", body={
        "text": "make him dance ballet drifting towards the camera",
        "summaries": False,
    }))
    assert payload["matches"][0]["summary"] == ""


def test_dupes_ignore_round_trip(call, store):
    first = store.create(body="make him dance ballet toward the camera")
    second = store.create(body="make him dance ballet towards the camera")
    payload = ok(call("post", "/dupes/ignore", body={"a": first["id"],
                                                     "b": second["id"]}))
    assert payload["changed"] is True and payload["ignored"] is True
    assert store.is_ignored(first["id"], second["id"])

    payload = ok(call("post", "/dupes", body={"id": first["id"],
                                              "exclude_id": first["id"]}))
    assert payload["matches"] == []

    payload = ok(call("post", "/dupes/ignore", body={"a": first["id"],
                                                     "b": second["id"],
                                                     "unignore": True}))
    assert payload["ignored"] is False
    assert not store.is_ignored(first["id"], second["id"])


def test_compare_by_id_and_text(call, store):
    first = store.create(body="drifting toward the camera")
    second = store.create(body="drifting towards the camera")
    payload = ok(call("post", "/compare", body={"a_id": first["id"],
                                                "b_id": second["id"]}))
    assert set(payload) >= {"score", "pct", "summary", "diff"}
    assert payload["pct"] > 80
    assert any(chunk.get("op") for chunk in payload["diff"])

    payload = ok(call("post", "/compare", body={"a_text": "cat", "b_text": "dog"}))
    assert payload["pct"] < 100


def test_compare_unknown_id_is_404(call, store):
    status, payload = call("post", "/compare", body={"a_id": "nope", "b_text": "x"})
    assert status == 404
    assert payload["code"] == "not_found"


def test_merge(call, store):
    first = store.create(body="one")
    second = store.create(body="two")
    payload = ok(call("post", "/merge", body={"winner": first["id"],
                                              "loser": second["id"]}))
    assert payload["prompt"]["id"] == first["id"]
    assert store.count() == 1


def test_merge_into_itself_is_400(call, store):
    rec = store.create(body="one")
    status, payload = call("post", "/merge", body={"winner": rec["id"],
                                                   "loser": rec["id"]})
    assert status == 400
    assert payload["code"] == "same_record"


def test_merge_new(call, store):
    first = store.create(body="one")
    second = store.create(body="two")
    payload = ok(call("post", "/merge_new", body={
        "a": first["id"], "b": second["id"], "body": "one two",
    }))
    assert payload["prompt"]["body"] == "one two"
    assert store.count() == 1


def test_merge_new_without_a_body_is_400(call, store):
    first = store.create(body="one")
    second = store.create(body="two")
    status, payload = call("post", "/merge_new", body={
        "a": first["id"], "b": second["id"], "body": "",
    })
    assert status == 400
    assert payload["code"] == "bad_request"


def test_versions_restore(call, store):
    rec = store.create(body="first")
    store.update(rec["id"], body="second")
    payload = ok(call("post", "/versions/restore", body={"id": rec["id"],
                                                         "index": 0}))
    assert payload["prompt"]["body"] == "first"
    # Restore snapshots the current body first: history is never erased.
    assert len(payload["prompt"]["versions"]) == 2


# --------------------------------------------------------------------------- #
# POST — resolve / taxonomy / snippets / import
# --------------------------------------------------------------------------- #

def test_resolve_samples(call, store):
    payload = ok(call("post", "/resolve", body={
        "text": "{a|b|c|d|e|f|g|h} {a|b|c|d|e|f|g|h}", "seed": 0, "n": 6,
    }))
    assert set(payload) >= {"text", "samples", "picks", "missing", "warnings"}
    assert len(payload["samples"]) == 6
    assert payload["samples"][0] == payload["text"]
    assert len(set(payload["samples"])) > 1


def test_resolve_uses_stored_snippets(call, store):
    store.set_snippet("cine", "volumetric haze")
    payload = ok(call("post", "/resolve", body={"text": "[[cine]]", "n": 1}))
    assert payload["text"] == "volumetric haze"


def test_resolve_reports_missing(call, store):
    payload = ok(call("post", "/resolve", body={"text": "[[nope]]"}))
    assert payload["missing"] == ["[[nope]]"]


def test_snippet_set_and_delete(call, store):
    payload = ok(call("post", "/snippet", body={"op": "set", "name": "cine",
                                                "body": "35mm"}))
    assert payload["snippets"]["cine"]["body"] == "35mm"
    payload = ok(call("post", "/snippet", body={"op": "delete", "name": "cine"}))
    assert "cine" not in payload["snippets"]


def test_snippet_delete_unknown_is_404(call, store):
    status, payload = call("post", "/snippet", body={"op": "delete", "name": "nope"})
    assert status == 404
    assert payload["code"] == "not_found"


def test_settings(call, store):
    payload = ok(call("post", "/settings", body={"dupe_threshold": 0.8,
                                                 "version_cap": 10}))
    assert payload["settings"]["dupe_threshold"] == 0.8
    assert payload["settings"]["version_cap"] == 10
    assert ok(call("get", "/ping"))["threshold"] == 0.8


def test_import_and_export_round_trip(call, store):
    store.create(body="one", tags=["t"])
    library = ok(call("get", "/export"))["library"]

    store.import_raw({"prompts": []}, replace=True)
    assert store.count() == 0

    payload = ok(call("post", "/import", body={"library": library, "replace": True}))
    assert payload["count"] == 1
    assert store.all()[0]["body"] == "one"


# --------------------------------------------------------------------------- #
# Error mapping
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(("exc", "status", "code"), [
    (librarian_store.NotFoundError("x"), 404, "not_found"),
    (librarian_store.BodyTooLargeError("x"), 413, "too_large"),
    (librarian_store.ReadOnlyError("x"), 409, "readonly"),
    (librarian_store.ConflictError("x"), 409, "conflict"),
    (librarian_store.SameRecordError("x"), 400, "same_record"),
    (librarian_store.StoreWriteError("x"), 500, "write_failed"),
    (ValueError("x"), 400, "bad_request"),
    (RuntimeError("x"), 500, "internal"),
])
def test_store_exceptions_map_to_codes(call, store, monkeypatch, exc, status, code):
    def _raise():
        raise exc

    monkeypatch.setattr(store, "taxonomy", _raise)
    got_status, payload = call("get", "/taxonomy")
    assert got_status == status
    assert payload["code"] == code
    assert payload["error"]
    assert "rev" in payload


def test_a_handler_bug_never_escapes_the_guard(call, store, monkeypatch):
    monkeypatch.setattr(store, "count", lambda: 1 / 0)
    status, payload = call("get", "/ping")
    assert status == 500
    assert payload["code"] == "internal"
