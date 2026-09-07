"""Resolve seeded choices, wildcard files, and snippets without import-time I/O.
Escape syntax before expanding snippets, files, then innermost braces.
Bound passes, per-name recursion, and output size; unresolved forms stay literal.
Substitution order is deterministic, but edited wildcard files can change
output for the same seed; the node includes their signature in IS_CHANGED.
"""

from . import resolver as _resolver
from .files import WILDCARD_EXT, WildcardFiles
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

#: Shared instance used when ``resolve()`` is called without ``files=``.
FILES = WildcardFiles()


def signature():
    """Digest of the wildcards-directory listing. See :meth:`WildcardFiles.dir_signature`."""
    return FILES.dir_signature()


def names():
    """Every available wildcard name."""
    return FILES.names()


def resolve(text, seed=0, *, files=None, snippets=None, collect=None):
    """Resolve every wildcard form in ``text`` and return the result.

    ``seed`` seeds a private ``random.Random``, so the same ``(text, seed)``
    always produces the same output. ``files`` is a :class:`WildcardFiles` (or
    anything with ``options(name)``); ``snippets`` is a dict or callable.
    Both default to the live store.

    ``collect``, when a dict, is filled in with ``picks``, ``missing`` and
    ``warnings`` -- that is how :func:`resolve_verbose` gets its detail
    without a second resolution pass.

    Never raises for user input: a missing wildcard file or snippet is left as
    literal text and reported in ``missing``.
    """
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


def resolve_verbose(text, seed=0, *, files=None, snippets=None):
    """``{text, picks, missing, warnings}`` -- what the preview popover renders."""
    collect = {}
    out = resolve(text, seed, files=files, snippets=snippets, collect=collect)
    return {
        "text": out,
        "picks": collect.get("picks", []),
        "missing": collect.get("missing", []),
        "warnings": collect.get("warnings", []),
    }


__all__ = [
    "FILES",
    "MAX_DEPTH",
    "MAX_OUTPUT",
    "MAX_PASSES",
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
    "signature",
    "unescape",
]
