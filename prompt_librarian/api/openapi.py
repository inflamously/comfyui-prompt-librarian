"""The route table, rendered as an OpenAPI 3.1 document.

Nothing at runtime imports this module — ComfyUI never loads it, and
``api/__init__.py`` deliberately does not pull it in. It is the only place in
the pack that needs pydantic, which is a ``dev`` extra and never a dependency
of the node itself.

There is no schema-building code here. Every request and response is a
dataclass in :mod:`.schemas`, and ``TypeAdapter(T).json_schema()`` turns it
into JSON Schema — refs, enums, nullables, defaults and field descriptions
included. What is left is assembly: walking ``utils._ROUTES``, hoisting the
generated ``$defs`` into ``components/schemas``, and splitting a query
dataclass into ``parameters[]`` because OpenAPI wants query fields one at a
time rather than as an object.

The handlers cannot be introspected — they take a bare ``request`` and read
``data.get("name")`` — so the types in :mod:`.schemas` are a parallel
declaration, and keeping them true to the handlers is a review question.
``tests/test_openapi.py`` covers the mechanical half: a route with no types, a
response that forgets the ``rev`` envelope, a duplicate operation id, a
capability or error code that drifted from the live table.
"""

from pydantic import TypeAdapter

from . import schemas
from .config import _ERROR_MAP, PREFIX
from .utils import _ROUTES

OPENAPI_VERSION = "3.1.0"

REF_TEMPLATE = "#/components/schemas/{model}"

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
# Types -> components
# --------------------------------------------------------------------------- #

def _register(components, name, generated):
    """Add one generated schema, refusing to overwrite a different one."""
    resident = components.get(name)
    if resident is not None and resident != generated:
        raise ValueError(f"two different schemas generated for {name!r}")
    components[name] = generated


def _ref(kind, components):
    """Register ``kind`` (and everything it references) and return a ``$ref``."""
    generated = TypeAdapter(kind).json_schema(ref_template=REF_TEMPLATE)
    for name, nested in generated.pop("$defs", {}).items():
        _register(components, name, nested)
    _register(components, kind.__name__, generated)
    return {"$ref": REF_TEMPLATE.format(model=kind.__name__)}


def _parameters(kind):
    """A query dataclass split into OpenAPI query parameters."""
    generated = TypeAdapter(kind).json_schema(ref_template=REF_TEMPLATE)
    if generated.get("$defs"):
        raise ValueError(f"{kind.__name__} nests a model; query params must be flat")
    required = set(generated.get("required", ()))
    out = []
    for name, schema in generated.get("properties", {}).items():
        param = {"name": name, "in": "query", "required": name in required}
        description = schema.pop("description", None)
        if description:
            param["description"] = description
        if schema.get("type") == "array":
            # `?tags=a,b`, not `?tags=a&tags=b`: the handler reads the query as
            # a flat dict and splits on commas, so repeats would be lost.
            param["style"] = "form"
            param["explode"] = False
        param["schema"] = schema
        out.append(param)
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


def _operation(route, components):
    spec = route.spec
    out = {"operationId": spec.op, "tags": [tag_for(route.path)]}
    if spec.summary:
        out["summary"] = spec.summary
    if spec.query is not None:
        out["parameters"] = _parameters(spec.query)
    if spec.body is not None:
        ref = _ref(spec.body, components)
        # The body is required exactly when some field has no default.
        required = bool(components[spec.body.__name__].get("required"))
        out["requestBody"] = {"required": required,
                              "content": {"application/json": {"schema": ref}}}
    out["responses"] = _responses(route, components)
    return out


def _responses(route, components):
    if not issubclass(route.spec.returns, schemas.Envelope):
        # Every payload carries `rev`; a response type that does not inherit
        # the envelope would document a field the handler always sends.
        raise ValueError(f"{route.spec.returns.__name__} does not inherit Envelope")
    out = {"200": {"description": "Success.",
                   "content": {"application/json":
                               {"schema": _ref(route.spec.returns, components)}}}}
    error = _ref(schemas.Error, components)
    codes = {}
    for _, status, code in _ERROR_MAP:
        codes.setdefault(str(status), []).append(code)
    codes.setdefault("500", []).append("internal")
    for status, names in codes.items():
        out[status] = {"description": "code: " + ", ".join(sorted(set(names))),
                       "content": {"application/json": {"schema": error}}}
    return out


def document(version="0"):
    """The whole OpenAPI document as a plain dict, ready for ``json.dumps``.

    Raises ``ValueError`` on a duplicate operation id, a response that is not an
    :class:`schemas.Envelope`, or a query type that nests a model — a malformed
    route table fails here rather than emitting a spec that quietly lies.
    """
    paths, components, seen = {}, {}, {}
    for route in _ROUTES:
        clash = seen.get(route.spec.op)
        if clash is not None:
            raise ValueError(f"duplicate operation id {route.spec.op!r} "
                             f"on {route.path} and {clash}")
        seen[route.spec.op] = route.path
        paths.setdefault(route.path, {})[route.method] = _operation(route, components)
    return {
        "openapi": OPENAPI_VERSION,
        "info": {"title": TITLE, "version": version, "description": DESCRIPTION},
        "servers": [
            {"url": "/", "description": "The ComfyUI server root."},
            {"url": "/api", "description": "ComfyUI's /api prefix — same routes."},
        ],
        "tags": [{"name": name} for name in sorted({tag_for(p) for p in paths})],
        "paths": paths,
        "components": {"schemas": dict(sorted(components.items()))},
    }
