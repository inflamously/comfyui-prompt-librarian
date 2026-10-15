"""The OpenAPI document, assembled from the route table."""

from .. import schemas
from ..config import _ERROR_MAP
from ..utils import _ROUTES
from . import overrides
from .components import parameters, ref

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


def tag_for(route):
    """The Swagger UI group: the ``api/routes/<group>.py`` that declares the route."""
    return route.handler.__module__.rsplit(".", 1)[-1]


def _operation(route, components):
    spec = route.spec
    out = {"operationId": spec.op, "tags": [tag_for(route)]}
    if spec.summary:
        out["summary"] = spec.summary
    if spec.query is not None:
        out["parameters"] = parameters(spec.query)
    if spec.op in overrides.REQUEST_BODIES:
        out["requestBody"] = overrides.REQUEST_BODIES[spec.op](components)
    elif spec.body is not None:
        body = ref(spec.body, components)
        out["requestBody"] = {"required": bool(components[spec.body.__name__].get("required")),
                              "content": {"application/json": {"schema": body}}}
    out["responses"] = {"200": _success(spec, components), **_errors(components)}
    return out


def _success(spec, components):
    if spec.op in overrides.SUCCESS:
        return overrides.SUCCESS[spec.op](components)
    if not issubclass(spec.returns, schemas.Envelope):
        # Response types must inherit the rev envelope that handlers always emit.
        raise ValueError(f"{spec.returns.__name__} does not inherit Envelope")
    return {"description": "Success.",
            "content": {"application/json": {"schema": ref(spec.returns, components)}}}


def _errors(components):
    error = ref(schemas.Error, components)
    codes = {}
    for _, status, code in _ERROR_MAP:
        codes.setdefault(str(status), []).append(code)
    codes.setdefault("500", []).append("internal")
    return {status: {"description": "code: " + ", ".join(sorted(set(names))),
                     "content": {"application/json": {"schema": error}}}
            for status, names in codes.items()}


def document(version="0"):
    """The whole OpenAPI document as a dict; raises ValueError on a malformed route table."""
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
        "tags": [{"name": name} for name in sorted({tag_for(route) for route in _ROUTES})],
        "paths": paths,
        "components": {"schemas": dict(sorted(components.items()))},
    }
