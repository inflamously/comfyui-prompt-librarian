"""Resolve seeded choices, wildcard files, and snippets without import-time I/O."""

from collections.abc import Callable

from . import resolver as _resolver
from .files import WILDCARD_EXT, WildcardFiles
from . import sources as _sources
from .sources import _default_snippets
from .syntax import (
    S_LB,
    S_LSB,
    S_PIPE,
    S_RB,
    S_RSB,
    S_US,
    _SNIPPET_RE,
    escape,
    has_wildcards,
    referenced_names,
    unescape,
)

# Public defaults are read at call time so callers can replace FILES or tune
# the guards without changing the resolver's implementation modules.
MAX_DEPTH = 10
MAX_PASSES = 20
MAX_OUTPUT = 200000
#: How many samples one preview may ask for.
MAX_SAMPLES = 50

#: Shared instance used when ``resolve()`` is called without ``files=``.
FILES = WildcardFiles()


def configure(
    root: str | Callable[[], str] | None = None,
    snippets: Callable[[], dict] | None = None,
) -> None:
    """Point the defaults at a library: its wildcard directory and snippet source."""
    global FILES
    if root is not None:
        FILES = WildcardFiles(root=root)
    if snippets is not None:
        _sources.use_snippets(snippets)


def signature() -> str:
    """Digest of the wildcards-directory listing. See :meth:`WildcardFiles.dir_signature`."""
    return FILES.dir_signature()


def names() -> list[str]:
    """Every available wildcard name."""
    return FILES.names()


def resolve(
    text: object,
    seed: int = 0,
    *,
    files: WildcardFiles | None = None,
    snippets: object = None,
    collect: dict | None = None,
) -> str:
    """Resolve every wildcard form in ``text``, deterministic per ``seed``; never raises."""
    source = "" if text is None else str(text)

    if files is None:
        files = FILES
    if snippets is None:
        snippets = _default_snippets() if _SNIPPET_RE.search(source) else {}
    return _resolver.resolve(
        source,
        seed,
        files=files,
        snippets=snippets,
        collect=collect,
        max_depth=MAX_DEPTH,
        max_passes=MAX_PASSES,
        max_output=MAX_OUTPUT,
    )


def resolve_verbose(
    text: object, seed: int = 0, *, files: WildcardFiles | None = None, snippets: object = None
) -> dict[str, object]:
    """``{text, picks, missing, warnings}`` -- what the preview popover renders."""
    collect: dict = {}
    out = resolve(text, seed, files=files, snippets=snippets, collect=collect)
    return {
        "text": out,
        "picks": collect.get("picks", []),
        "missing": collect.get("missing", []),
        "warnings": collect.get("warnings", []),
    }



def sample(
    text: object, seed: int = 0, count: int = 1, *, snippets: object = None
) -> dict[str, object]:
    """Resolve ``text`` at ``seed``, ``seed + 1``, ... (``count`` clamped to 1..MAX_SAMPLES)."""
    count = max(1, min(count, MAX_SAMPLES))
    first = resolve_verbose(text, seed, snippets=snippets)
    rest = [resolve(text, seed + offset, snippets=snippets) for offset in range(1, count)]
    return {**first, "samples": [first["text"], *rest]}


__all__ = [
    "FILES",
    "configure",
    "MAX_DEPTH",
    "MAX_OUTPUT",
    "MAX_PASSES",
    "MAX_SAMPLES",
    "S_LB",
    "S_LSB",
    "S_PIPE",
    "S_RB",
    "S_RSB",
    "S_US",
    "WILDCARD_EXT",
    "WildcardFiles",
    "escape",
    "has_wildcards",
    "names",
    "referenced_names",
    "resolve",
    "resolve_verbose",
    "sample",
    "signature",
    "unescape",
]
