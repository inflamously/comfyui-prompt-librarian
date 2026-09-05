"""Where wildcard files live and where ``[[snippets]]`` come from.

The composition root calls :func:`use_snippets` (and ``configure`` in the package);
wildcards never import the library. Everything here is resolved lazily.
"""

from collections.abc import Callable

from ...shared.paths import wildcards_dir

_snippets_provider: Callable[[], dict] | None = None


def use_snippets(provider: Callable[[], dict] | None) -> None:
    """Set the zero-argument callable that returns ``{name: body | {"body": ...}}``."""
    global _snippets_provider
    _snippets_provider = provider


def _default_wildcards_dir() -> str:
    """Where ``__name__`` files live by default: next to the library file."""
    return wildcards_dir()


def _snippet_body(source: object, name: str) -> str | None:
    """Look ``name`` up in ``source``; ``None`` when it does not exist.

    ``source`` may be a dict of ``{name: body}``, a dict of the library's
    ``{name: {"body": ...}}`` shape, or any callable taking a name.
    """
    if source is None:
        return None
    if callable(source):
        try:
            value = source(name)
        except Exception:
            return None
    else:
        try:
            value = source[name]
        except (KeyError, TypeError, IndexError):
            return None
    if value is None:
        return None
    if isinstance(value, dict):
        return str(value.get("body", ""))
    return str(value)


def _default_snippets() -> dict:
    """Snippets from the configured provider; empty when none or when it fails."""
    if _snippets_provider is None:
        return {}
    try:
        return _snippets_provider() or {}
    except Exception:
        return {}
