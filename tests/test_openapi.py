"""Tests for ``prompt_librarian.api.openapi``.

The generator is only worth having if it cannot quietly lie, so most of what is
here is drift protection: every route described, every descriptor understood,
every operation id unique and every ``$ref`` resolvable. The document itself is
built without aiohttp and without ComfyUI, which is the other property worth
holding onto — ``scripts/openapi.py`` has to run from a plain checkout.
"""

import json

import pytest

from prompt_librarian.api import openapi
from prompt_librarian.api.utils import _ROUTES

# --------------------------------------------------------------------------- #
# Descriptors
# --------------------------------------------------------------------------- #

def test_primitives_and_required():
    assert openapi.parse("str") == ({"type": "string"}, False)
    assert openapi.parse("int!") == ({"type": "integer"}, True)
    assert openapi.parse("any") == ({}, False)


def test_arrays_maps_enums_and_nullables():
    assert openapi.schema("str[]") == {"type": "array", "items": {"type": "string"}}
    assert openapi.schema("str[][]") == {
        "type": "array", "items": {"type": "array", "items": {"type": "string"}}}
    assert openapi.schema("{int}") == {
        "type": "object", "additionalProperties": {"type": "integer"}}
    assert openapi.schema("str=a|b") == {"type": "string", "enum": ["a", "b"]}
    assert openapi.schema("int?") == {"type": ["integer", "null"]}


def test_model_names_become_refs():
    assert openapi.schema("Prompt") == {"$ref": "#/components/schemas/Prompt"}
    assert openapi.schema("Prompt[]") == {
        "type": "array", "items": {"$ref": "#/components/schemas/Prompt"}}
    # A $ref cannot carry a sibling `type`, so a nullable model widens instead.
    assert openapi.schema("Prompt?") == {
        "anyOf": [{"$ref": "#/components/schemas/Prompt"}, {"type": "null"}]}


def test_unknown_descriptor_raises():
    with pytest.raises(ValueError, match="Widget"):
        openapi.schema("Widget")


# --------------------------------------------------------------------------- #
# The document
# --------------------------------------------------------------------------- #

def test_every_route_is_described():
    doc = openapi.document()
    described = {(method, path)
                 for path, item in doc["paths"].items() for method in item}
    assert described == {(route.method, route.path) for route in _ROUTES}
    assert len(described) == len(_ROUTES)


def test_every_route_has_an_operation_id_and_a_summary():
    for route in _ROUTES:
        assert route.spec.op, route.path
        assert route.spec.summary, route.path


def test_operation_ids_are_unique_and_camel_case():
    ops = [route.spec.op for route in _ROUTES]
    assert len(set(ops)) == len(ops)
    for op in ops:
        assert op[0].islower() and op.isalnum(), op


def test_every_descriptor_on_every_route_parses():
    # `document()` walks all of them; an unknown one raises rather than
    # emitting a field the client cannot make sense of.
    doc = openapi.document()
    assert doc["openapi"].startswith("3.1")


def test_every_ref_resolves():
    doc = openapi.document()
    schemas = doc["components"]["schemas"]
    for ref in _refs(doc):
        assert ref.startswith("#/components/schemas/"), ref
        assert ref.rsplit("/", 1)[-1] in schemas, ref


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


def test_capabilities_and_error_codes_track_the_live_tables():
    from prompt_librarian.api.config import _ERROR_MAP, CAPABILITIES

    schemas = openapi.document()["components"]["schemas"]
    assert set(schemas["Capabilities"]["properties"]) == set(CAPABILITIES)
    codes = set(schemas["Error"]["properties"]["code"]["enum"])
    assert codes == {code for _, _, code in _ERROR_MAP} | {"internal"}


def test_reads_take_query_params_and_writes_take_bodies():
    for route in _ROUTES:
        if route.method == "get":
            assert not route.spec.body, route.path
        else:
            assert not route.spec.query, route.path


def test_responses_always_carry_rev():
    doc = openapi.document()
    for path, item in doc["paths"].items():
        for method, operation in item.items():
            body = operation["responses"]["200"]["content"]["application/json"]["schema"]
            props = body.get("properties")
            if props is None:
                # The response *is* a model; `rev` is merged on top of the ref.
                props = body["allOf"][-1]["properties"]
            assert "rev" in props, (method, path)


def test_document_is_json_serializable():
    assert json.loads(json.dumps(openapi.document(version="1.2.3")))["info"]["version"] \
        == "1.2.3"
