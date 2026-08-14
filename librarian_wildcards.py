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

import hashlib
import os
import random
import re

# The store is optional: this module must stay importable (and testable) with
# no ComfyUI and no `folder_paths` anywhere in sight.
try:  # package import inside ComfyUI, flat import in tests / tooling
    try:
        from .librarian_store import STORE as _STORE
        from .librarian_store import wildcards_dir as _store_wildcards_dir
    except ImportError:  # pragma: no cover - exercised by the flat-import path
        from librarian_store import STORE as _STORE
        from librarian_store import wildcards_dir as _store_wildcards_dir
except Exception:  # pragma: no cover - no store at all (bare unit use)
    _STORE = None
    _store_wildcards_dir = None


# --------------------------------------------------------------------------- #
# Guards
# --------------------------------------------------------------------------- #

MAX_DEPTH = 10          # brace nesting per pass, and expansions per named source
MAX_PASSES = 20         # whole-text rounds
MAX_OUTPUT = 200000     # characters; past this we keep the last good text

WILDCARD_EXT = ".txt"


# --------------------------------------------------------------------------- #
# Escaping
# --------------------------------------------------------------------------- #
# Private Use Area, so they can never collide with real prompt text.

S_LB = "\ue000"   # {
S_PIPE = "\ue001"  # |
S_RB = "\ue002"   # }
S_US = "\ue003"   # _
S_LSB = "\ue004"  # [
S_RSB = "\ue005"  # ]

_SENTINEL_OF = {"{": S_LB, "|": S_PIPE, "}": S_RB, "_": S_US, "[": S_LSB, "]": S_RSB}
_LITERAL_OF = {v: k for k, v in _SENTINEL_OF.items()}

_ESCAPE_RE = re.compile(r"\\([{}|_\[\]])")
_UNESCAPE_RE = re.compile("[%s]" % "".join(_LITERAL_OF))


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


# --------------------------------------------------------------------------- #
# Wildcard files
# --------------------------------------------------------------------------- #

def _default_wildcards_dir():
    """Where ``__name__`` files live. Resolved lazily -- never at import time."""
    if _STORE is not None:
        try:
            return _STORE.wildcards_dir()
        except Exception:
            pass
    if _store_wildcards_dir is not None:
        try:
            return _store_wildcards_dir()
        except Exception:
            pass
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "wildcards")


def _safe_name(name):
    """Reject a wildcard name that could escape the wildcards directory.

    Checked *before* any filesystem call: ``..`` anywhere, an absolute or
    root-relative path, a Windows drive letter or a UNC prefix. The
    ``realpath`` + ``commonpath`` containment check in
    :meth:`WildcardFiles.path_for` is the second half of the guard, catching
    symlinks that point outside.
    """
    if not name or "\x00" in name:
        return None
    cleaned = name.replace("\\", "/").strip()
    if not cleaned:
        return None
    if cleaned.startswith("/") or cleaned.startswith("//"):
        return None
    if re.match(r"^[A-Za-z]:", cleaned):          # C:\..., C:/...
        return None
    parts = [p for p in cleaned.split("/") if p not in ("", ".")]
    if not parts:
        return None
    if any(p == ".." for p in parts):
        return None
    if any(p.endswith(".") or p.endswith(" ") for p in parts):  # Windows oddities
        return None
    return "/".join(parts)


def _parse_options(raw_text):
    """Lines of a wildcard file: blanks and ``#`` comments dropped, ``\\r`` stripped."""
    out = []
    for line in raw_text.split("\n"):
        line = line.replace("\r", "").strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


class WildcardFiles:
    """Mtime-keyed cache over the wildcards directory.

    ``root`` may be a path, a zero-argument callable, or ``None`` (resolve the
    store's wildcards directory lazily at first use). Nothing here touches the
    filesystem until a lookup actually happens.
    """

    def __init__(self, root=None):
        self._root = root
        self._cache = {}      # name -> (mtime_ns, size, [options])

    # -- paths ------------------------------------------------------------- #

    def root(self):
        """The wildcards directory this instance reads from."""
        if callable(self._root):
            return self._root()
        if self._root:
            return self._root
        return _default_wildcards_dir()

    def path_for(self, name):
        """Absolute path of ``name``'s ``.txt`` file, or ``None`` when unsafe.

        Two-stage guard: :func:`_safe_name` rejects the obvious traversals up
        front, then ``realpath`` + ``commonpath`` proves the resolved file
        really sits inside the wildcards directory (which is what catches a
        symlink pointing out of it).
        """
        safe = _safe_name(name)
        if safe is None:
            return None
        root = self.root()
        candidate = os.path.join(root, *safe.split("/"))
        if not candidate.lower().endswith(WILDCARD_EXT):
            candidate += WILDCARD_EXT
        try:
            real_root = os.path.realpath(root)
            real_path = os.path.realpath(candidate)
            if os.path.commonpath([real_root, real_path]) != real_root:
                return None
        except (OSError, ValueError):
            # ValueError: commonpath across drives on Windows.
            return None
        return real_path

    # -- lookups ----------------------------------------------------------- #

    def options(self, name):
        """Options for ``name``, or ``None`` when the file is missing/unsafe.

        Cached on ``(st_mtime_ns, st_size)``, so an unchanged file is one
        ``os.stat`` per lookup and an edited one is picked up immediately.
        """
        path = self.path_for(name)
        if path is None:
            return None
        try:
            st = os.stat(path)
        except OSError:
            self._cache.pop(name, None)
            return None
        sig = (st.st_mtime_ns, st.st_size)
        hit = self._cache.get(name)
        if hit is not None and hit[0] == sig[0] and hit[1] == sig[1]:
            return hit[2]
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                raw = handle.read()
        except OSError:
            self._cache.pop(name, None)
            return None
        options = _parse_options(raw)
        self._cache[name] = (sig[0], sig[1], options)
        return options

    def names(self):
        """Every wildcard name under the directory, ``/``-separated, sorted."""
        root = self.root()
        out = []
        try:
            walker = os.walk(root)
        except OSError:
            return out
        for dirpath, dirnames, filenames in walker:
            dirnames.sort()
            for filename in sorted(filenames):
                if not filename.lower().endswith(WILDCARD_EXT):
                    continue
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                out.append(rel[: -len(WILDCARD_EXT)])
        return sorted(out)

    def dir_signature(self):
        """sha1 over ``(name, mtime_ns, size)`` for every wildcard file.

        Folded into the node's ``IS_CHANGED`` so editing a wildcard file
        reruns the graph. Content is deliberately *not* hashed: stat is O(1)
        per file and a content change always moves mtime or size.
        """
        root = self.root()
        digest = hashlib.sha1()
        digest.update(b"pl-wildcards-v1")
        for name in self.names():
            path = os.path.join(root, *name.split("/")) + WILDCARD_EXT
            try:
                st = os.stat(path)
                stamp = "%s|%d|%d" % (name, st.st_mtime_ns, st.st_size)
            except OSError:
                stamp = "%s|missing" % (name,)
            digest.update(stamp.encode("utf-8", "replace"))
            digest.update(b"\x00")
        return digest.hexdigest()

    def invalidate(self):
        """Drop the mtime cache (tests, and the ``/wildcards`` reload button)."""
        self._cache.clear()


#: Shared instance used when ``resolve()`` is called without ``files=``.
FILES = WildcardFiles()


def signature():
    """Digest of the wildcards-directory listing. See :meth:`WildcardFiles.dir_signature`."""
    return FILES.dir_signature()


def names():
    """Every available wildcard name."""
    return FILES.names()


# --------------------------------------------------------------------------- #
# Snippets
# --------------------------------------------------------------------------- #

def _snippet_body(source, name):
    """Look ``name`` up in ``source``; ``None`` when it does not exist.

    ``source`` may be a dict of ``{name: body}``, a dict of the store's
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


def _default_snippets():
    if _STORE is None:
        return {}
    try:
        return _STORE.snippets()
    except Exception:
        return {}


# --------------------------------------------------------------------------- #
# Choice parsing
# --------------------------------------------------------------------------- #

def _split_options(inner):
    """Split a brace body on real pipes (escaped ones are already sentinels)."""
    return inner.split("|")


def _weigh(option):
    """``("text", weight)`` for one option, honouring a ``N::`` prefix."""
    match = _WEIGHT_RE.match(option)
    if match:
        try:
            weight = float(match.group(1))
        except ValueError:
            weight = 1.0
        return match.group(2), max(0.0, weight)
    return option, 1.0


def _weighted_pick(rng, entries):
    """Pick one ``(text, weight)`` entry. Falls back to uniform when all weigh 0."""
    total = sum(weight for _, weight in entries)
    if total <= 0.0:
        return entries[rng.randrange(len(entries))][0]
    target = rng.random() * total
    upto = 0.0
    for text, weight in entries:
        upto += weight
        if target < upto:
            return text
    return entries[-1][0]


def _pick_n(rng, entries, count):
    """Pick ``count`` *distinct* entries, weighted, in selection order."""
    pool = list(entries)
    count = max(0, min(count, len(pool)))
    chosen = []
    for _ in range(count):
        text = _weighted_pick(rng, pool)
        chosen.append(text)
        for index, (candidate, _weight) in enumerate(pool):
            if candidate == text:
                pool.pop(index)
                break
        if not pool:
            break
    return chosen


def _resolve_brace(inner, rng):
    """Resolve one innermost brace body to its replacement text."""
    pick_match = _PICK_RE.match(inner)
    low = high = None
    if pick_match:
        low = int(pick_match.group(1))
        high = int(pick_match.group(2)) if pick_match.group(2) is not None else low
        inner = pick_match.group(3)
        if high < low:
            low, high = high, low

    entries = [_weigh(part) for part in _split_options(inner)]
    if not entries:
        return ""

    if low is None:
        return _weighted_pick(rng, entries)

    count = low if high == low else rng.randint(low, high)
    return ", ".join(_pick_n(rng, entries, count))


# --------------------------------------------------------------------------- #
# The resolver
# --------------------------------------------------------------------------- #

class _Context(object):
    """Per-``resolve()`` mutable state. One instance, never shared."""

    __slots__ = ("rng", "files", "snippets", "picks", "missing", "warnings",
                 "file_uses", "snippet_uses", "changed", "overflow", "seen_missing",
                 "seen_warning", "size")

    def __init__(self, rng, files, snippets):
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
        """Book ``replacement`` against the output budget.

        ``re.sub`` gives no running length, so the context tracks it: each
        substitution books its own delta. Returning False means the expansion
        would blow ``MAX_OUTPUT``, so the caller leaves the token literal —
        the text stays *valid* and truncation never lands mid-expansion.
        """
        delta = len(replacement) - len(matched)
        if self.size + delta > MAX_OUTPUT:
            self.overflow = True
            return False
        self.size += delta
        return True


def _expand_snippets(text, ctx):
    ctx.size = len(text)

    def _sub(match):
        name = match.group(1).strip()
        uses = ctx.snippet_uses.get(name, 0)
        if uses >= MAX_DEPTH:
            # Cycle guard: neutralize to sentinels so it can never re-match.
            ctx.warn("snippet [[%s]] expanded too many times; left literal" % name)
            return S_LSB + S_LSB + name + S_RSB + S_RSB
        body = _snippet_body(ctx.snippets, name)
        if body is None:
            ctx.miss("[[%s]]" % name)
            return match.group(0)          # literal, and no change recorded
        replacement = escape(body)         # escapes inside a snippet still work
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
        if uses >= MAX_DEPTH:
            # A self-referencing wildcard file lands here and degrades to
            # literal text rather than looping forever.
            ctx.warn("wildcard __%s__ expanded too many times; left literal" % name)
            return S_US + S_US + name + S_US + S_US
        options = ctx.files.options(name) if ctx.files is not None else None
        if not options:
            ctx.miss("__%s__" % name)
            return match.group(0)          # literal, never an exception
        value = options[ctx.rng.randrange(len(options))]
        replacement = escape(value)
        if not ctx.afford(match.group(0), replacement):
            return match.group(0)
        ctx.file_uses[name] = uses + 1
        ctx.changed = True
        ctx.picks.append({"kind": "wildcard", "name": name, "value": value,
                          "count": len(options)})
        return replacement

    return _FILE_RE.sub(_sub, text)


def _expand_braces(text, ctx):
    """Peel innermost braces, one nesting level per iteration."""
    for _ in range(MAX_DEPTH):
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
            ctx.picks.append({"kind": "choice", "name": unescape(inner),
                              "value": unescape(value)})
            return value

        text = _BRACE_RE.sub(_sub, text)
        if text == snapshot or ctx.overflow:
            return text
    if _BRACE_RE.search(text):
        ctx.warn("brace nesting deeper than %d; left unresolved" % MAX_DEPTH)
    return text


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

    ctx = _Context(random.Random(seed), files, snippets)
    working = escape(source)

    for _ in range(MAX_PASSES):
        ctx.changed = False
        before = working

        for step in (_expand_snippets, _expand_files, _expand_braces):
            step_before = working
            working = step(working, ctx)
            if len(working) > MAX_OUTPUT:
                # Hard backstop; the per-substitution budget should have caught
                # this already, so reaching here means keeping the last good text.
                working = step_before
                ctx.overflow = True
            if ctx.overflow:
                break
        if ctx.overflow:
            ctx.warn("expansion exceeded %d characters; stopped early" % MAX_OUTPUT)
            break
        if not ctx.changed and working == before:
            break
    else:
        if ctx.changed:
            ctx.warn("stopped after %d passes; output may be incomplete" % MAX_PASSES)

    out = unescape(working)
    if isinstance(collect, dict):
        collect["picks"] = ctx.picks
        collect["missing"] = ctx.missing
        collect["warnings"] = ctx.warnings
    return out


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
