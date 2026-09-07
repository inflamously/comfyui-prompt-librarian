"""The JS frontend and the Python route table must describe the same API.

``web/prompt_librarian/api/routes.js`` is one method per backend route, written
by hand against ``prompt_librarian/api/routes/``. Nothing checked that the two
still agreed: a renamed route is a 404 that only shows up when a user clicks the
button, and the frontend hedges against exactly that by sending duplicate keys
(``{text, body}``, ``{winner, winner_id}``, ...) with comments saying a rename on
either side must not break the hot path.

This is that check. The JS side is enumerated by *executing* it — a subprocess
runs ``tests-js/tools/dump-routes.mjs``, which invokes all 30 ``API`` methods
against a recording transport and prints what would go on the wire. No regex
parsing, and no dependency on ``openapi.json`` (gitignored, generated on demand,
needs pydantic).

Skips cleanly when node or the JS tree is absent, so the rest of the suite still
runs for a contributor who has not installed Node.
"""

import json
import os
import shutil
import subprocess

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
_DUMP = os.path.join(_ROOT, "tests-js", "tools", "dump-routes.mjs")

pytest.importorskip("aiohttp")

from prompt_librarian import api  # noqa: E402
from prompt_librarian.api.utils import _ROUTES  # noqa: E402

# The frontend has one method per route, except that setSnippet and delSnippet
# both POST to /snippet — so 36 methods describe 35 routes.
EXPECTED_ROUTES = 35
EXPECTED_METHODS = 36


def _node():
    exe = shutil.which("node")
    if exe is None:
        pytest.skip("node is not installed; the JS/Python route contract was not checked")
    if not os.path.exists(_DUMP):
        pytest.skip(f"{_DUMP} is missing; the JS/Python route contract was not checked")
    return exe


@pytest.fixture(scope="module")
def js_records():
    """What the frontend actually puts on the wire, one entry per API method."""
    exe = _node()
    proc = subprocess.run(  # noqa: S603
        [exe, _DUMP],
        cwd=_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        pytest.fail(
            "dump-routes.mjs failed:\n"
            f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive
        pytest.fail(f"dump-routes.mjs printed non-JSON ({exc}):\n{proc.stdout[:2000]}")


@pytest.fixture(scope="module")
def py_routes():
    """The Python route table, as ``{(method, path)}``."""
    return {(route.method.lower(), route.path) for route in _ROUTES}


def test_python_route_table_is_the_expected_size(py_routes):
    # Guards against the contract silently passing because one side is empty.
    assert len(py_routes) == EXPECTED_ROUTES


def test_every_js_method_was_exercised(js_records):
    assert len(js_records) == EXPECTED_METHODS
    assert len({r["fn"] for r in js_records}) == EXPECTED_METHODS


def test_js_and_python_describe_the_same_routes(js_records, py_routes):
    js = {(r["method"], r["path"]) for r in js_records}
    only_js = sorted(f"{m.upper()} {p}" for m, p in js - py_routes)
    only_py = sorted(f"{m.upper()} {p}" for m, p in py_routes - js)
    assert not only_js, f"the frontend calls routes the backend does not serve: {only_js}"
    assert not only_py, f"the backend serves routes the frontend never calls: {only_py}"


def test_the_two_snippet_methods_are_the_only_shared_route(js_records):
    by_route = {}
    for rec in js_records:
        by_route.setdefault((rec["method"], rec["path"]), []).append(rec["fn"])
    shared = {route: fns for route, fns in by_route.items() if len(fns) > 1}
    assert {r[1] for r in shared} == {api.PREFIX + "/snippet"}, (
        f"unexpected methods sharing a route: {shared}"
    )


def test_reads_are_get_and_writes_are_post(js_records):
    # The convention api/__init__.py states: every read GET, every write POST,
    # no PATCH/DELETE verbs and no path parameters.
    for rec in js_records:
        assert rec["method"] in ("get", "post"), rec
        assert rec["path"].startswith(api.PREFIX + "/"), rec
        assert "{" not in rec["path"], f"{rec['fn']} uses a path parameter"
        if rec["method"] == "get":
            assert rec["body"] == [], f"{rec['fn']} is a GET but sends a body"
        else:
            assert rec["body"], f"{rec['fn']} is a POST but sends no body"


@pytest.mark.parametrize("route", sorted({(r.method.lower(), r.path) for r in _ROUTES}))
def test_each_python_route_has_a_frontend_caller(route, js_records):
    # Parametrised so a missing route is named individually rather than buried
    # in one set difference.
    js = {(r["method"], r["path"]) for r in js_records}
    assert route in js, f"no frontend method calls {route[0].upper()} {route[1]}"


def test_autocomplete_query_contract(js_records):
    rec = next(r for r in js_records if r["fn"] == "autocomplete")
    assert rec["query"] == ["limit", "phrase_prefix", "word_prefix"]
