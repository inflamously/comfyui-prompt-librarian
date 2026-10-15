"""Development-only route table description: a text listing or an OpenAPI 3.1 document."""

from .listing import table

__all__ = ["document", "table"]


def document(version="0"):
    """The whole OpenAPI document as a plain dict; see :func:`.spec.document`."""
    from .spec import document as build  # noqa: WPS433 - pydantic stays optional
    return build(version)
