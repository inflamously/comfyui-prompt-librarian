"""Tests for ``prompt_librarian.api.openapi`` and the types it reads.

The generator is only worth having if it cannot quietly lie, so most of what is
here is drift protection: every route typed, every response carrying the ``rev``
envelope, every operation id unique, every ``$ref`` resolvable, and the two
tables that are declared twice — capabilities and error codes — still agreeing
with the live ones.

Schema generation itself is pydantic's job and is not retested here. The module
skips wholesale without pydantic, which is a ``dev`` extra: the pack never
imports it, and neither does the route listing.
"""

import json
from dataclasses import MISSING, fields, is_dataclass

import pytest

pytest.importorskip("pydantic")

from prompt_librarian.api import openapi, schemas  # noqa: E402
from prompt_librarian.api.config import _ERROR_MAP, CAPABILITIES  # noqa: E402
from prompt_librarian.api.utils import _ROUTES  # noqa: E402


@pytest.fixture(scope="module")
def doc():
    return openapi.document(version="1.2.3")


# --------------------------------------------------------------------------- #
# The route table
# --------------------------------------------------------------------------- #

def test_every_route_is_typed():
    for route in _ROUTES:
        assert route.spec.op, route.path
        assert route.spec.summary, route.path
        assert is_dataclass(route.spec.returns), route.path
        for takes in (route.spec.query, route.spec.body):
            assert takes is None or is_dataclass(takes), route.path


def test_operation_ids_are_unique_and_camel_case():
    ops = [route.spec.op for route in _ROUTES]
    assert len(set(ops)) == len(ops)
    for op in ops:
        assert op[0].islower() and op.isalnum(), op


def test_reads_take_query_params_and_writes_take_bodies():
    for route in _ROUTES:
        if route.method == "get":
            assert route.spec.body is None, route.path
        else:
            assert route.spec.query is None, route.path


def test_every_response_inherits_the_rev_envelope():
    for route in _ROUTES:
        assert issubclass(route.spec.returns, schemas.Envelope), route.path


def test_query_types_are_flat():
    # A query dataclass is split into `parameters[]`, so a nested model would
    # have nowhere to go; `document()` raises rather than dropping it.
    for route in _ROUTES:
        if route.spec.query is None:
            continue
        for entry in fields(route.spec.query):
            assert not is_dataclass(entry.type), (route.path, entry.name)


# --------------------------------------------------------------------------- #
# The document
# --------------------------------------------------------------------------- #

def test_every_route_is_described(doc):
    described = {(method, path)
                 for path, item in doc["paths"].items() for method in item}
    assert described == {(route.method, route.path) for route in _ROUTES}


def test_every_ref_resolves(doc):
    schemas_by_name = doc["components"]["schemas"]
    refs = list(_refs(doc))
    assert refs
    for ref in refs:
        assert ref.startswith("#/components/schemas/"), ref
        assert ref.rsplit("/", 1)[-1] in schemas_by_name, ref


def _refs(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref":
                yield value
            else:
                yield from _refs(value)
    elif isinstance(node, list):
        for item in node:
            yield from _refs(item)


def test_required_query_params_are_the_ones_without_defaults(doc):
    params = {p["name"]: p for p
              in doc["paths"]["/prompt_librarian/versions"]["get"]["parameters"]}
    assert params["id"]["required"] is True
    assert params["chars"]["required"] is False
    assert params["chars"]["schema"]["default"] == 160


def test_list_params_are_comma_separated(doc):
    tags = next(p for p in doc["paths"]["/prompt_librarian/search"]["get"]["parameters"]
                if p["name"] == "tags")
    # `?tags=a,b`, which is what the handler's `_list` splits.
    assert tags["style"] == "form" and tags["explode"] is False


def test_attribute_docstrings_become_field_descriptions(doc):
    hit = doc["components"]["schemas"]["SearchHit"]["properties"]["match_pct"]
    assert "threshold" in hit["description"]


def test_every_operation_documents_the_error_envelope(doc):
    statuses = {str(status) for _, status, _ in _ERROR_MAP} | {"500"}
    error = "#/components/schemas/Error"
    for path, item in doc["paths"].items():
        for method, operation in item.items():
            assert statuses <= set(operation["responses"]), (method, path)
            for status in statuses:
                schema = operation["responses"][status]["content"]["application/json"]
                assert schema["schema"]["$ref"] == error, (method, path, status)


def test_document_is_json_serializable(doc):
    assert json.loads(json.dumps(doc))["info"]["version"] == "1.2.3"


# --------------------------------------------------------------------------- #
# The two tables that are declared twice
# --------------------------------------------------------------------------- #

def test_capabilities_match_the_live_table():
    assert {entry.name for entry in fields(schemas.Capabilities)} == set(CAPABILITIES)


def test_error_codes_match_the_live_table(doc):
    codes = set(doc["components"]["schemas"]["Error"]["properties"]["code"]["enum"])
    assert codes == {code for _, _, code in _ERROR_MAP} | {"internal"}


def test_prompt_type_matches_a_real_record(store):
    """The one model the store can be asked to prove: a created record."""
    record = store.create(name="n", body="b", category="c", tags=["t"])
    declared = {entry.name for entry in fields(schemas.Prompt)}
    assert declared == set(record)


def test_settings_type_matches_the_stored_block(store):
    declared = {entry.name for entry in fields(schemas.Settings)}
    assert declared == set(store.settings())


def test_response_defaults_are_not_invented():
    # A response field with a default would let the spec claim a value the
    # handler never sends. Only `WildcardPick.count` is genuinely optional.
    for name in dir(schemas):
        kind = getattr(schemas, name)
        if not (is_dataclass(kind) and isinstance(kind, type)
                and issubclass(kind, schemas.Envelope)):
            continue
        for entry in fields(kind):
            assert entry.default is MISSING and entry.default_factory is MISSING, \
                (name, entry.name)
