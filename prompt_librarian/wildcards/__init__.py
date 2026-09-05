"""Wildcard / snippet resolution for the Prompt Librarian.

Pure stdlib, no third-party imports, no filesystem access at import time.

Syntax
------

===========================  ==================================================
``{a|b|c}``                  pick one at random
``{3::a|b}``                 weighted -- ``a`` is three times as likely as ``b``
``{2$$a|b|c}``               pick 2 *distinct* options, joined with ``", "``
``{1-3$$a|b|c}``             pick between 1 and 3 distinct options
``__name__``                 a random line from ``<wildcards>/name.txt``
``__sub/dir/name__``         subdirectories are allowed
``[[snippet]]``              inline a stored snippet body
``\\{ \\| \\} \\_ \\[ \\]``  escapes -- the character survives verbatim
===========================  ==================================================

Algorithm
---------

1. **Escape pass.** ``\\{`` and friends become private-use sentinels
   (``U+E000``..``U+E005``). This is the only way ``\\|`` *inside* a choice can
   work without hand-writing a parser: after this pass every remaining ``|``,
   ``{``, ``}``, ``_``, ``[``, ``]`` is unambiguously syntax.
2. Repeat, up to ``MAX_PASSES`` times, until a full pass substitutes nothing:

   a. snippets (``[[name]]``)
   b. wildcard files (``__name__``)
   c. innermost braces -- ``re.sub`` with ``\\{([^{}]*)\\}`` applied repeatedly.
      Because the pattern cannot match a brace containing braces, each round
      peels exactly one level and nesting comes out correct with no parser.

3. **Unescape pass.** Sentinels become their literal characters again.

Because expansions feed the next pass, ``__a__`` can contain ``{x|y}`` and a
snippet can contain ``__b__``. Because they are *bounded* passes with per-name
expansion counters, a self-referencing wildcard file degrades to literal text
instead of hanging the prompt worker.

Guards: ``MAX_DEPTH`` (nesting depth per pass and expansions per name),
``MAX_PASSES`` (whole-text rounds), ``MAX_OUTPUT`` (characters). An expansion
bomb stops at the last good text and is reported in ``warnings``.

Determinism
-----------

One ``random.Random(seed)`` per :func:`resolve` call, and a fully determined
substitution order (left-to-right within a pass, innermost-first across
passes), so the same ``(text, seed)`` always yields the same output.

The documented caveat: *editing a wildcard file changes the output for a fixed
seed.* That is why :func:`signature` exists -- the node folds a digest of the
wildcards-directory listing into ``IS_CHANGED`` so ComfyUI reruns when a
wildcard file is edited, and only when the text actually uses wildcards.
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
