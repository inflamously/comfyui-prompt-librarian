"""Wildcard patterns, escape sentinels, and reference detection."""

import re

S_LB = "\ue000"  # {
S_PIPE = "\ue001"  # |
S_RB = "\ue002"  # }
S_US = "\ue003"  # _
S_LSB = "\ue004"  # [
S_RSB = "\ue005"  # ]

_SENTINEL_OF = {"{": S_LB, "|": S_PIPE, "}": S_RB, "_": S_US, "[": S_LSB, "]": S_RSB}
_LITERAL_OF = {v: k for k, v in _SENTINEL_OF.items()}

_ESCAPE_RE = re.compile(r"\\([{}|_\[\]])")
_UNESCAPE_RE = re.compile("[{}]".format("".join(_LITERAL_OF)))


def escape(text):
    """Turn ``\\{``-style escapes into sentinels. Safe to apply to inserted text."""
    return _ESCAPE_RE.sub(lambda m: _SENTINEL_OF[m.group(1)], text)


def unescape(text):
    """Turn sentinels back into the literal characters they stand for."""
    return _UNESCAPE_RE.sub(lambda m: _LITERAL_OF[m.group(0)], text)


# --------------------------------------------------------------------------- #
# Patterns
# --------------------------------------------------------------------------- #

# Innermost braces only: the body cannot itself contain a brace, so repeated
# application peels one nesting level at a time.
_BRACE_RE = re.compile(r"\{([^{}]*)\}")

# `__name__`, `__sub/dir/name__`. Lazy, so `__foo_bar__` yields `foo_bar` (the
# lazy quantifier still has to reach a literal `__`).
_FILE_RE = re.compile(r"__([\w\-./\\]+?)__", re.UNICODE)

_SNIPPET_RE = re.compile(r"\[\[([^\[\]]*)\]\]")

# `{2$$...}` / `{1-3$$...}` -- the pick-N prefix.
_PICK_RE = re.compile(r"^\s*(\d+)(?:\s*-\s*(\d+))?\s*\$\$(.*)$", re.DOTALL)

# `3::text` / `1.5::text` -- the per-option weight prefix.
_WEIGHT_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*::(.*)$", re.DOTALL)

_ANY_WILDCARD_RE = (_BRACE_RE, _FILE_RE, _SNIPPET_RE)


def has_wildcards(text):
    """True when ``text`` contains any *unescaped* wildcard form.

    The node uses this to decide whether :func:`signature` belongs in
    ``IS_CHANGED``: folding a directory digest into every hash would rerun
    graphs that contain no wildcards at all.
    """
    if not text:
        return False
    working = escape(str(text))
    return any(pattern.search(working) for pattern in _ANY_WILDCARD_RE)


def referenced_names(text):
    """The set of ``__name__`` wildcard files ``text`` refers to (unescaped only).

    Snippets are not included -- they are stored in the library, not on disk,
    and so do not participate in :func:`signature`.
    """
    if not text:
        return set()
    working = escape(str(text))
    return {match.group(1) for match in _FILE_RE.finditer(working)}
