"""library: the portable file round-trip."""

from ... import schemas
from ..components import ref


def _import_file_body(components):
    return {
        "required": True,
        "content": {"multipart/form-data": {"schema": {
            "type": "object",
            "properties": {"library": {"type": "string", "format": "binary"}},
            "required": ["library"],
        }}},
    }


def _export_file_ok(components):
    return {
        "description": "Portable schema-1 JSON library download.",
        "headers": {"Content-Disposition": {"schema": {"type": "string"},
                                            "description": "Attachment filename."}},
        "content": {"application/json": {"schema": ref(schemas.Library, components)}},
    }


REQUEST_BODIES = {"importLibraryFile": _import_file_body}

SUCCESS = {"exportLibraryFile": _export_file_ok}
