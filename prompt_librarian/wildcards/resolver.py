"""Bounded expansion passes and per-resolution state."""

import random

from .choices import _resolve_brace
from .sources import _snippet_body
from .syntax import (
    _BRACE_RE,
    _FILE_RE,
    _SNIPPET_RE,
    S_LB,
    S_LSB,
    S_RB,
    S_RSB,
    S_US,
    escape,
    unescape,
)


class _Context:
    """Per-``resolve()`` mutable state. One instance, never shared."""

    __slots__ = (
        "rng",
        "files",
        "snippets",
        "picks",
        "missing",
        "warnings",
        "file_uses",
        "snippet_uses",
        "changed",
        "overflow",
        "seen_missing",
        "seen_warning",
        "size",
        "max_depth",
        "max_output",
    )

    def __init__(self, rng, files, snippets, max_depth, max_output):
        self.max_depth = max_depth
        self.max_output = max_output
        self.rng = rng
        self.files = files
        self.snippets = snippets
        self.picks = []
        self.missing = []
        self.warnings = []
        self.file_uses = {}
        self.snippet_uses = {}
        self.changed = False
        self.overflow = False
        self.seen_missing = set()
        self.seen_warning = set()
        self.size = 0

    def warn(self, message):
        if message not in self.seen_warning:
            self.seen_warning.add(message)
            self.warnings.append(message)

    def miss(self, token):
        if token not in self.seen_missing:
            self.seen_missing.add(token)
            self.missing.append(token)

    def afford(self, matched, replacement):
        """Track substitution length deltas because re.sub has no running size.
        Reject expansions over MAX_OUTPUT, leaving the original token intact.
        """
        delta = len(replacement) - len(matched)
        if self.size + delta > self.max_output:
            self.overflow = True
            return False
        self.size += delta
        return True


def _expand_snippets(text, ctx):
    ctx.size = len(text)

    def _sub(match):
        name = match.group(1).strip()
        uses = ctx.snippet_uses.get(name, 0)
        if uses >= ctx.max_depth:
            # Cycle guard: neutralize to sentinels so it can never re-match.
            ctx.warn(f"snippet [[{name}]] expanded too many times; left literal")
            return S_LSB + S_LSB + name + S_RSB + S_RSB
        body = _snippet_body(ctx.snippets, name)
        if body is None:
            ctx.miss(f"[[{name}]]")
            return match.group(0)  # literal, and no change recorded
        replacement = escape(body)  # escapes inside a snippet still work
        if not ctx.afford(match.group(0), replacement):
            return match.group(0)
        ctx.snippet_uses[name] = uses + 1
        ctx.changed = True
        ctx.picks.append({"kind": "snippet", "name": name, "value": body})
        return replacement

    return _SNIPPET_RE.sub(_sub, text)


def _expand_files(text, ctx):
    ctx.size = len(text)

    def _sub(match):
        name = match.group(1)
        uses = ctx.file_uses.get(name, 0)
        if uses >= ctx.max_depth:
            # A self-referencing wildcard file lands here and degrades to
            # literal text rather than looping forever.
            ctx.warn(f"wildcard __{name}__ expanded too many times; left literal")
            return S_US + S_US + name + S_US + S_US
        options = ctx.files.options(name) if ctx.files is not None else None
        if not options:
            ctx.miss(f"__{name}__")
            return match.group(0)  # literal, never an exception
        value = options[ctx.rng.randrange(len(options))]
        replacement = escape(value)
        if not ctx.afford(match.group(0), replacement):
            return match.group(0)
        ctx.file_uses[name] = uses + 1
        ctx.changed = True
        ctx.picks.append({"kind": "wildcard", "name": name, "value": value, "count": len(options)})
        return replacement

    return _FILE_RE.sub(_sub, text)


def _expand_braces(text, ctx):
    """Peel innermost braces, one nesting level per iteration."""
    for _ in range(ctx.max_depth):
        snapshot = text
        ctx.size = len(text)

        def _sub(match):
            inner = match.group(1)
            value = _resolve_brace(inner, ctx.rng)
            if not ctx.afford(match.group(0), value):
                # Leave the braces in place but neutralized, so the aborted
                # choice cannot be retried on the next pass.
                return S_LB + inner + S_RB
            ctx.changed = True
            ctx.picks.append({"kind": "choice", "name": unescape(inner), "value": unescape(value)})
            return value

        text = _BRACE_RE.sub(_sub, text)
        if text == snapshot or ctx.overflow:
            return text
    if _BRACE_RE.search(text):
        ctx.warn(f"brace nesting deeper than {ctx.max_depth}; left unresolved")
    return text


def resolve(text, seed=0, *, files, snippets, collect=None, max_depth, max_passes, max_output):
    """Resolve text with explicit sources and per-call expansion limits."""
    ctx = _Context(random.Random(seed), files, snippets, max_depth, max_output)
    working = escape(text)

    for _ in range(max_passes):
        ctx.changed = False
        before = working

        for step in (_expand_snippets, _expand_files, _expand_braces):
            step_before = working
            working = step(working, ctx)
            if len(working) > max_output:
                # Hard backstop; the per-substitution budget should have caught
                # this already, so reaching here means keeping the last good text.
                working = step_before
                ctx.overflow = True
            if ctx.overflow:
                break
        if ctx.overflow:
            ctx.warn(f"expansion exceeded {max_output} characters; stopped early")
            break
        if not ctx.changed and working == before:
            break
    else:
        if ctx.changed:
            ctx.warn(f"stopped after {max_passes} passes; output may be incomplete")

    out = unescape(working)
    if isinstance(collect, dict):
        collect["picks"] = ctx.picks
        collect["missing"] = ctx.missing
        collect["warnings"] = ctx.warnings
    return out
