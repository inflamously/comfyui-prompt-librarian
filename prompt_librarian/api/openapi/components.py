"""pydantic generates every schema; this only hoists them into ``components``."""

from pydantic import TypeAdapter

REF_TEMPLATE = "#/components/schemas/{model}"


def _register(components, name, generated):
    """Add one generated schema, refusing to overwrite a different one."""
    resident = components.get(name)
    if resident is not None and resident != generated:
        raise ValueError(f"two different schemas generated for {name!r}")
    components[name] = generated


def ref(kind, components):
    """Register ``kind`` (and everything it references) and return a ``$ref``."""
    generated = TypeAdapter(kind).json_schema(ref_template=REF_TEMPLATE)
    for name, nested in generated.pop("$defs", {}).items():
        _register(components, name, nested)
    _register(components, kind.__name__, generated)
    return {"$ref": REF_TEMPLATE.format(model=kind.__name__)}


def parameters(kind):
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
