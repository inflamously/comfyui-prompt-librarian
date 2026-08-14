"""The route table, rendered as an OpenAPI 3.1 document.

Nothing at runtime imports this module — ComfyUI never loads it, and
``api/__init__.py`` deliberately does not pull it in. It exists so
``scripts/openapi.py`` can answer "what routes are there, and what does each
one take?" from the route table itself rather than from a document somebody
has to remember to update.

The one thing that *is* written twice is the response shape: :data:`MODELS`
describes what the store hands back, and the store is where those dicts are
actually built. That is the cost of having a spec at all without type
annotations on the store; the field maps on the handlers, the capability list
and the error codes are all read from the live objects, so only the models can
drift. ``tests/test_openapi.py`` catches the drift that is mechanical
(a route with no spec, an unknown descriptor, a duplicate operation id) — the
rest is a review question.

Field descriptors are the shorthand :mod:`.utils` documents; :func:`parse`
is the whole of the grammar::

    str  int  float  bool  object  any      primitives
    Prompt                                  a model in MODELS -> $ref
    str[]  Prompt[]  str[][]                arrays, nestable
    {int}  {Snippet}                        an object keyed by arbitrary strings
    str=add|rename|delete                   an enum
    Prompt?                                 nullable
    str!                                    required (parameters and bodies only)
"""

from .config import _ERROR_MAP, CAPABILITIES, PREFIX
from .utils import _ROUTES

OPENAPI_VERSION = "3.1.0"

TITLE = "ComfyUI Prompt Librarian"

DESCRIPTION = """
The `/prompt_librarian/*` routes the Librarian panel talks to.

Conventions that hold for every operation:

* **Every read is GET, every write is POST.** No PATCH/DELETE and no path
  parameters — that is what survives ComfyUI's `/api` prefix rewriting.
* **Every response carries `rev`**, the store's revision counter, errors
  included, so a client can always tell whether its view is stale.
* **Every error is `{error, code, rev}`.** The `code` values are stable and
  worth branching on; the prose is not. The error responses listed on each
  operation are the package-wide table — a given endpoint will only ever
  raise the subset that applies to it.
* Unknown query parameters and body fields are ignored, and a malformed body
  is read as an empty one, so a client typo is never a 500.
""".strip()

#: Response shapes, as ``{model: {field: descriptor}}``. See the module
#: docstring on why these are the one hand-maintained part of the spec.
MODELS = {
    "Prompt": {
        "id": "str", "name": "str", "body": "str", "category": "str",
        "tags": "str[]", "rating": "int", "used": "int", "last_run": "str",
        "created": "str", "updated": "str", "notes": "str", "pinned": "bool",
        "versions": "Version[]",
    },
    "Version": {"body": "str", "name": "str", "ts": "str", "src": "str?"},
    "VersionPreview": {
        "index": "int", "name": "str", "ts": "str", "src": "str?",
        "chars": "int", "preview": "str",
    },
    "SearchHit": {
        "id": "str", "name": "str", "preview": "str", "category": "str",
        "tags": "str[]", "rating": "int", "used": "int", "last_run": "str",
        "updated": "str", "chars": "int", "version_count": "int",
        "score": "float", "dupe_count": "int", "match_pct": "int?",
    },
    "SearchResult": {
        "rev": "int", "total": "int", "offset": "int", "limit": "int",
        "threshold": "float", "took_ms": "float", "dupes_partial": "bool",
        "fallback": "bool", "hits": "SearchHit[]",
    },
    "PromptMeta": {
        "name": "str", "rating": "int", "used": "int", "category": "str",
        "tags": "str[]", "near_dupes": "int", "updated": "str",
    },
    "DupeMatch": {
        "id": "str", "name": "str", "score": "float", "pct": "int",
        "summary": "str", "preview": "str", "used": "int", "updated": "str",
    },
    "DiffChunk": {
        "op": "str=equal|replace|insert|delete",
        "a_start": "int", "a_end": "int", "b_start": "int", "b_end": "int",
        "a_tokens": "str[]", "b_tokens": "str[]",
    },
    "DiffResult": {
        "score": "float", "pct": "int", "summary": "str", "diff": "DiffChunk[]",
    },
    "WildcardPick": {
        "kind": "str=wildcard|snippet|choice", "name": "str", "value": "str",
        "count": "int",
    },
    "Snippet": {"body": "str", "updated": "str"},
    "Settings": {"dupe_threshold": "float", "version_cap": "int"},
    "CategoryCount": {"name": "str", "count": "int"},
    "TagCount": {"tag": "str", "count": "int"},
    "Taxonomy": {
        "categories": "CategoryCount[]", "tags": "TagCount[]", "total": "int",
    },
    "Library": {
        "schema": "int", "updated": "str", "settings": "Settings",
        "categories": "str[]", "snippets": "{Snippet}", "ignored": "str[][]",
        "prompts": "Prompt[]",
    },
    # Read from the live objects: a new capability or a new mapped exception
    # shows up in the spec without anyone editing this file.
    "Capabilities": dict.fromkeys(CAPABILITIES, "bool"),
    "Error": {
        "error": "str",
        "code": "str=" + "|".join([code for _, _, code in _ERROR_MAP] + ["internal"]),
        "rev": "int",
    },
}

_PRIMITIVES = {
    "str": {"type": "string"},
    "int": {"type": "integer"},
    "float": {"type": "number"},
    "bool": {"type": "boolean"},
    "object": {"type": "object"},
    "any": {},
}

# Matched in order against the path with PREFIX stripped; the fallback is the
# first path segment, so a new route is never silently untagged.
_TAGS = (
    ("/bulk/", "bulk"),
    ("/dupes", "dupes"),
    ("/compare", "dupes"),
    ("/version", "versions"),
    ("/snippet", "snippets"),
    ("/wildcard", "wildcards"),
    ("/resolve", "wildcards"),
    ("/category", "taxonomy"),
    ("/taxonomy", "taxonomy"),
    ("/export", "library"),
    ("/import", "library"),
    ("/settings", "library"),
    ("/ping", "library"),
    ("/search", "search"),
    ("/prompt", "prompts"),
    ("/meta", "prompts"),
    ("/create", "prompts"),
    ("/update", "prompts"),
    ("/rate", "prompts"),
    ("/delete", "prompts"),
    ("/usage", "prompts"),
    ("/merge", "prompts"),
)


# --------------------------------------------------------------------------- #
# Descriptors -> JSON Schema
# --------------------------------------------------------------------------- #

def parse(descriptor):
    """``(schema, required)`` for one field descriptor. Raises on an unknown one."""
    text = str(descriptor).strip()
    required = text.endswith("!")
    if required:
        text = text[:-1].strip()
    return schema(text), required


def schema(text):
    """JSON Schema for a descriptor with the ``!`` already stripped."""
    text = text.strip()
    if text.endswith("?"):
        return _nullable(schema(text[:-1]))
    if text.startswith("{") and text.endswith("}"):
        return {"type": "object", "additionalProperties": schema(text[1:-1])}
    if text.endswith("[]"):
        return {"type": "array", "items": schema(text[:-2])}
    if "=" in text:
        name, _, values = text.partition("=")
        return {**schema(name), "enum": values.split("|")}
    if text in _PRIMITIVES:
        return dict(_PRIMITIVES[text])
    if text in MODELS:
        return {"$ref": f"#/components/schemas/{text}"}
    raise ValueError(f"unknown field descriptor {text!r}")


def _nullable(inner):
    kind = inner.get("type")
    if kind is None:
        # A $ref cannot carry a sibling type, so widen it instead.
        return {"anyOf": [inner, {"type": "null"}]} if inner else {}
    return {**inner, "type": [kind, "null"]}


def _object(fields):
    """An object schema from a ``{name: descriptor}`` map."""
    properties, required = {}, []
    for name, descriptor in fields.items():
        properties[name], is_required = parse(descriptor)
        if is_required:
            required.append(name)
    out = {"type": "object", "properties": properties}
    if required:
        out["required"] = required
    return out


# --------------------------------------------------------------------------- #
# Route table -> document
# --------------------------------------------------------------------------- #

def tag_for(path):
    """The Swagger UI group an operation lands in."""
    rest = path[len(PREFIX):] if path.startswith(PREFIX) else path
    for start, tag in _TAGS:
        if rest.startswith(start):
            return tag
    return rest.strip("/").split("/")[0] or "library"


def rows():
    """``[(METHOD, path, operation_id, summary)]`` in declaration order."""
    return [(route.method.upper(), route.path, route.spec.op, route.spec.summary)
            for route in _ROUTES]


def _responses(spec):
    if isinstance(spec.returns, str):
        # The response *is* the model; `rev` is merged in on top of it.
        body = {"allOf": [schema(spec.returns),
                          {"type": "object", "properties": {"rev": {"type": "integer"}}}]}
    else:
        body = _object({**spec.returns, "rev": "int"})
    out = {"200": {"description": "Success.",
                   "content": {"application/json": {"schema": body}}}}
    error = {"$ref": "#/components/schemas/Error"}
    codes = {}
    for _, status, code in _ERROR_MAP:
        codes.setdefault(str(status), []).append(code)
    codes.setdefault("500", []).append("internal")
    for status, names in codes.items():
        out[status] = {"description": "code: " + ", ".join(sorted(set(names))),
                       "content": {"application/json": {"schema": error}}}
    return out


def _operation(route):
    spec = route.spec
    out = {"operationId": spec.op, "tags": [tag_for(route.path)]}
    if spec.summary:
        out["summary"] = spec.summary
    if spec.query:
        out["parameters"] = []
        for name, descriptor in spec.query.items():
            field, required = parse(descriptor)
            param = {"name": name, "in": "query",
                     "required": required, "schema": field}
            if field.get("type") == "array":
                # `?tags=a,b`, not `?tags=a&tags=b`: the handler reads the query
                # as a flat dict and splits on commas, so repeats would be lost.
                param["style"] = "form"
                param["explode"] = False
            out["parameters"].append(param)
    if spec.body:
        body = _object(spec.body)
        out["requestBody"] = {"required": bool(body.get("required")),
                              "content": {"application/json": {"schema": body}}}
    out["responses"] = _responses(spec)
    return out


def document(version="0"):
    """The whole OpenAPI document as a plain dict, ready for ``json.dumps``.

    Raises ``ValueError`` on a duplicate operation id or an unknown descriptor,
    which is the point: a malformed route table fails here rather than emitting
    a spec that quietly lies.
    """
    paths, seen = {}, {}
    for route in _ROUTES:
        clash = seen.get(route.spec.op)
        if clash is not None:
            raise ValueError(f"duplicate operation id {route.spec.op!r} "
                             f"on {route.path} and {clash}")
        seen[route.spec.op] = route.path
        paths.setdefault(route.path, {})[route.method] = _operation(route)
    return {
        "openapi": OPENAPI_VERSION,
        "info": {"title": TITLE, "version": version, "description": DESCRIPTION},
        "servers": [
            {"url": "/", "description": "The ComfyUI server root."},
            {"url": "/api", "description": "ComfyUI's /api prefix — same routes."},
        ],
        "tags": [{"name": name} for name in sorted({tag_for(p) for p in paths})],
        "paths": paths,
        "components": {"schemas": {name: _object(fields)
                                   for name, fields in MODELS.items()}},
    }
