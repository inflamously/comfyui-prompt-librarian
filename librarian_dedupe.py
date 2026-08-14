"""Near-duplicate detection and word-level diffing for the Prompt Librarian.

Pure, stdlib-only.  Like ``librarian_search`` this module is driven by a plain
iterable of record dicts, a prebuilt :class:`DupeIndex`, or any store exposing
``list_all()`` and ``rev()``.

Public API
----------
``ratio(a, b, t)``                       -- cascaded SequenceMatcher ratio
``sim_norm(body)``                       -- normalized, capped comparison text
``length_ok(la, lb, t)``                 -- cheap length prefilter
``DupeIndex`` / ``build_dupe_index(records, rev=None)``
``find_similar(source, *, text, pid, exclude_id, threshold, limit,
               with_summary, ignored, rev)``
``dupe_counts(source, threshold, *, rev, exhaustive, ignored)``
``page_dupe_counts(source, pids, threshold, *, ignored)``
``dupe_ids(result)``
``patch(old_rec, new_rec, threshold, *, old_rev, new_rev, source)``
``invalidate(rev=None)``
``diff_tokens(a, b)`` / ``diff_summary(a, b, max_changes=3)`` / ``compare(a, b)``
"""

from __future__ import annotations

import difflib
import hashlib
import re
import threading
import unicodedata
from collections import OrderedDict
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

try:  # package import inside ComfyUI, flat import in tests / tooling
    from .librarian_search import normalize, preview as _preview
except ImportError:  # pragma: no cover - exercised by the flat-import path
    from librarian_search import normalize, preview as _preview

# --------------------------------------------------------------------------
# Tuning constants
# --------------------------------------------------------------------------

SIM_MAX_CHARS = 4000
DEFAULT_THRESHOLD = 0.90

RARE_TOKENS = 8            # probe tokens used for blocking
DF_ABS = 50                # df <= max(DF_ABS, DF_FRAC * n) counts as "rare"
DF_FRAC = 0.15
OVERLAP_FRAC = 0.5         # |A n B| >= OVERLAP_FRAC * min(|A|, |B|)
SHORT_DOC_TOKENS = 4       # < this many distinct tokens -> pull length buckets

ONE_CACHE_MAX = 512
ALL_CACHE_MAX = 4
INDEX_CACHE_MAX = 2

DIFF_OPCODE_CAP = 2000
SUMMARY_MAX_CHANGES = 3
SUMMARY_MAX_TOKENS = 5

LQUO = "“"            # curly quotes and a real arrow -- the UI renders
RQUO = "”"            # these verbatim, so they live in the payload
ARROW = "→"
ELLIPSIS = "…"

_WS_TOKEN_RE = re.compile(r"\S+")
_EDGE_PUNCT_RE = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)


# --------------------------------------------------------------------------
# Core similarity
# --------------------------------------------------------------------------


def sim_norm(body: Any) -> str:
    """Comparison form of a body: normalized then capped.

    Without the cap a pair of 100 KB bodies makes ``ratio()`` quadratic and
    the all-pairs scan never returns.
    """
    return normalize(body)[:SIM_MAX_CHARS]


def ratio(a: str, b: str, t: float = 0.0) -> float:
    """Similarity of ``a`` and ``b``, or 0.0 if it cannot reach ``t``.

    ``autojunk=False`` is MANDATORY: with the default, any character present
    in more than 1% of a sequence of length >= 200 is treated as junk, which
    for prompt text means spaces and common letters, and ``ratio()`` silently
    collapses toward zero.
    """
    if not a or not b:
        return 1.0 if (a == b and t <= 1.0) else 0.0
    # autojunk=False: see docstring -- popular-character heuristic destroys
    # similarity for prose-like prompt text. Do not "clean this up".
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    if t > 0.0:
        # real_quick_ratio() and quick_ratio() are exact upper bounds on
        # ratio(), so these early exits can never lose a real match.
        if sm.real_quick_ratio() < t:
            return 0.0
        if sm.quick_ratio() < t:
            return 0.0
    r = sm.ratio()
    if t > 0.0 and r < t:
        return 0.0
    return r


def length_ok(la: int, lb: int, t: float) -> bool:
    """Upper bound on ratio() from lengths alone: 2*min >= t*(la+lb)."""
    if la <= 0 or lb <= 0:
        return la == lb
    return 2 * min(la, lb) >= t * (la + lb)


def _sha1(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8", "replace")).hexdigest()


# --------------------------------------------------------------------------
# Dedupe-side index
# --------------------------------------------------------------------------


class DupeIndex:
    """Inverted index + length buckets used for two-stage candidate generation."""

    __slots__ = ("records", "norms", "toks", "postings", "length_buckets", "rev")

    def __init__(self, records: Optional[Iterable[Dict[str, Any]]] = None,
                 rev: Optional[int] = None):
        self.records: Dict[str, Dict[str, Any]] = {}
        self.norms: Dict[str, str] = {}
        self.toks: Dict[str, frozenset] = {}
        self.postings: Dict[str, Set[str]] = {}
        self.length_buckets: Dict[int, Set[str]] = {}
        self.rev = rev
        if records is not None:
            self.build(records, rev=rev)

    # -- construction ------------------------------------------------------

    def build(self, records: Iterable[Dict[str, Any]],
              rev: Optional[int] = None) -> "DupeIndex":
        self.records = {}
        self.norms = {}
        self.toks = {}
        self.postings = {}
        self.length_buckets = {}
        for rec in records or ():
            if isinstance(rec, dict):
                self.add(rec)
        if rev is not None:
            self.rev = rev
        return self

    def add(self, rec: Dict[str, Any]) -> Optional[str]:
        if not isinstance(rec, dict):
            return None
        pid = str(rec.get("id") or "")
        if not pid:
            return None
        if pid in self.records:
            self.remove(pid)
        norm = sim_norm(rec.get("body") or "")
        toks = frozenset(norm.split())
        self.records[pid] = rec
        self.norms[pid] = norm
        self.toks[pid] = toks
        for t in toks:
            self.postings.setdefault(t, set()).add(pid)
        self.length_buckets.setdefault(len(toks), set()).add(pid)
        return pid

    def remove(self, pid: str) -> bool:
        if pid not in self.records:
            return False
        toks = self.toks.pop(pid, frozenset())
        for t in toks:
            bucket = self.postings.get(t)
            if bucket is not None:
                bucket.discard(pid)
                if not bucket:
                    del self.postings[t]
        lb = self.length_buckets.get(len(toks))
        if lb is not None:
            lb.discard(pid)
            if not lb:
                del self.length_buckets[len(toks)]
        self.norms.pop(pid, None)
        self.records.pop(pid, None)
        return True

    def replace(self, rec: Dict[str, Any]) -> Optional[str]:
        return self.add(rec)

    def __len__(self) -> int:
        return len(self.records)

    # -- candidate generation ---------------------------------------------

    def df(self, token: str) -> int:
        b = self.postings.get(token)
        return len(b) if b else 0

    def candidates(self, toks: frozenset, norm_len: int, threshold: float,
                   exclude: Iterable[str] = ()) -> Set[str]:
        """Stage 1 (blocking) + stage 2 (cheap prefilters).

        Stage 1: the probe's ``RARE_TOKENS`` rarest tokens whose document
        frequency is <= ``max(DF_ABS, DF_FRAC * n)``, union of their postings.
        Short probes (< ``SHORT_DOC_TOKENS`` distinct tokens) and empty
        candidate sets additionally pull the adjacent token-length buckets --
        that is the recall escape hatch for documents that share only common
        tokens.

        Stage 2: ``length_ok`` and the overlap floor
        ``|A n B| >= OVERLAP_FRAC * min(|A|, |B|)``.  Overlap *count* rather
        than a Jaccard floor, because token Jaccard systematically
        under-estimates character ratio when tokens repeat.
        """
        n = len(self.records)
        cap = max(DF_ABS, DF_FRAC * n)
        rare = sorted((t for t in toks if self.df(t) <= cap), key=self.df)[:RARE_TOKENS]

        cand: Set[str] = set()
        for t in rare:
            cand |= self.postings.get(t, set())

        if len(toks) < SHORT_DOC_TOKENS or not cand:
            k = len(toks)
            for b in (k - 1, k, k + 1):
                cand |= self.length_buckets.get(b, set())

        for x in exclude:
            cand.discard(x)
        if not cand:
            return cand

        na = norm_len
        la = len(toks)
        out: Set[str] = set()
        for pid in cand:
            nb = len(self.norms.get(pid, ""))
            if not length_ok(na, nb, threshold):
                continue
            tb = self.toks.get(pid) or frozenset()
            lb = len(tb)
            if la and lb:
                need = OVERLAP_FRAC * min(la, lb)
                if len(toks & tb) < need:
                    continue
            out.add(pid)
        return out


def build_dupe_index(records: Iterable[Dict[str, Any]],
                     rev: Optional[int] = None) -> DupeIndex:
    return DupeIndex(records, rev=rev)


# --------------------------------------------------------------------------
# Caches
# --------------------------------------------------------------------------

_lock = threading.RLock()
_one_cache: "OrderedDict[tuple, list]" = OrderedDict()
_all_cache: "OrderedDict[tuple, dict]" = OrderedDict()
_index_cache: "OrderedDict[tuple, DupeIndex]" = OrderedDict()

_stats = {"one_calls": 0, "one_hits": 0, "all_calls": 0, "all_hits": 0,
          "index_builds": 0}


def cache_stats() -> Dict[str, int]:
    """Counters, for tests and for a debug endpoint."""
    with _lock:
        return dict(_stats)


def invalidate(rev: Optional[int] = None) -> None:
    """Drop cached results.  ``rev=None`` clears everything."""
    with _lock:
        if rev is None:
            _one_cache.clear()
            _all_cache.clear()
            _index_cache.clear()
            return
        rev = int(rev)
        for key in [k for k in _one_cache if k[2] == rev]:
            _one_cache.pop(key, None)
        for key in [k for k in _all_cache if k[0] == rev]:
            _all_cache.pop(key, None)
        for key in [k for k in _index_cache if k[1] == rev]:
            _index_cache.pop(key, None)


def _lru_put(cache: "OrderedDict", key, value, cap: int):
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > cap:
        cache.popitem(last=False)


def _lru_get(cache: "OrderedDict", key):
    if key in cache:
        cache.move_to_end(key)
        return cache[key]
    return None


# --------------------------------------------------------------------------
# Source coercion
# --------------------------------------------------------------------------


def _resolve(source: Any, rev: Optional[int] = None) -> DupeIndex:
    """Return a :class:`DupeIndex` for ``source``.

    ``source`` may be a :class:`DupeIndex`, a store (``list_all()`` +
    ``rev()``) or a plain iterable of record dicts.  Only stores and
    explicitly-versioned inputs get a non-``None`` ``rev``, and only a
    non-``None`` ``rev`` makes a result cacheable -- caching an unversioned
    list would collide across different record sets.
    """
    if isinstance(source, DupeIndex):
        if rev is not None and source.rev is None:
            source.rev = int(rev)
        return source
    if source is None:
        return DupeIndex([], rev=rev)
    list_all = getattr(source, "list_all", None)
    rev_fn = getattr(source, "rev", None)
    if callable(list_all) and callable(rev_fn):
        srev = int(rev_fn())
        key = (id(source), srev)
        with _lock:
            idx = _lru_get(_index_cache, key)
            if idx is not None:
                return idx
        idx = DupeIndex(list_all(), rev=srev)
        with _lock:
            _stats["index_builds"] += 1
            _lru_put(_index_cache, key, idx, INDEX_CACHE_MAX)
        return idx
    return DupeIndex(list(source), rev=(None if rev is None else int(rev)))


def _norm_ignored(ignored: Iterable[Any]) -> frozenset:
    out = set()
    for pair in ignored or ():
        try:
            a, b = pair
        except (TypeError, ValueError):
            continue
        out.add((a, b) if a <= b else (b, a))
    return frozenset(out)


# --------------------------------------------------------------------------
# One-vs-N
# --------------------------------------------------------------------------


def find_similar(
    source: Any,
    *,
    text: Optional[str] = None,
    pid: Optional[str] = None,
    exclude_id: Optional[str] = None,
    threshold: float = DEFAULT_THRESHOLD,
    limit: int = 10,
    with_summary: bool = True,
    ignored: Iterable[Any] = (),
    rev: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Records similar to ``text`` (or to record ``pid``'s body).

    Returns ``[{id, name, score, pct, summary, preview, used, updated}]``
    sorted by score descending.  ``exclude_id`` is how the save flow stops a
    record matching itself at 100%.  ``ignored`` is the store's "keep both"
    pair set; a pair is dropped when ``exclude_id``/``pid`` and the candidate
    appear in it.

    The returned list is the cached object when a cache hit occurs -- treat
    it as read-only.
    """
    idx = _resolve(source, rev)
    if text is None:
        if pid is None:
            return []
        rec = idx.records.get(pid)
        text = (rec or {}).get("body") or ""
    self_id = exclude_id if exclude_id is not None else pid
    ign = _norm_ignored(ignored)

    probe = sim_norm(text)
    if not probe:
        return []

    cache_key = None
    if idx.rev is not None:
        cache_key = (_sha1(probe), float(threshold), int(idx.rev),
                     self_id, int(limit), bool(with_summary), ign)
        with _lock:
            _stats["one_calls"] += 1
            hit = _lru_get(_one_cache, cache_key)
            if hit is not None:
                _stats["one_hits"] += 1
                return hit

    toks = frozenset(probe.split())
    exclude = [x for x in (self_id,) if x]
    cand = idx.candidates(toks, len(probe), threshold, exclude=exclude)

    scored: List[Tuple[float, str]] = []
    for cid in cand:
        if self_id and cid == self_id:
            continue
        if ign and self_id:
            pair = (self_id, cid) if self_id <= cid else (cid, self_id)
            if pair in ign:
                continue
        r = ratio(probe, idx.norms.get(cid, ""), threshold)
        if r >= threshold and r > 0.0:
            scored.append((r, cid))

    scored.sort(key=lambda p: (-p[0], (idx.records.get(p[1], {}).get("name") or "").casefold()))
    if limit and limit > 0:
        scored = scored[:limit]

    out: List[Dict[str, Any]] = []
    for r, cid in scored:
        rec = idx.records.get(cid, {})
        body = rec.get("body") or ""
        out.append({
            "id": cid,
            "name": rec.get("name") or "",
            "score": round(r, 6),
            "pct": int(round(r * 100)),
            "summary": diff_summary(text, body) if with_summary else "",
            "preview": _preview(body),
            "used": int(rec.get("used") or 0),
            "updated": str(rec.get("updated") or ""),
        })

    if cache_key is not None:
        with _lock:
            _lru_put(_one_cache, cache_key, out, ONE_CACHE_MAX)
    return out


def page_dupe_counts(source: Any, pids: Sequence[str],
                     threshold: float = DEFAULT_THRESHOLD,
                     *, ignored: Iterable[Any] = (),
                     rev: Optional[int] = None) -> Dict[str, int]:
    """Near-duplicate counts for a handful of ids only (one search page).

    This is what ``librarian_search.search(dupe_count_fn=...)`` should be
    handed: it never pays the all-pairs cost.
    """
    idx = _resolve(source, rev)
    ign = _norm_ignored(ignored)
    out: Dict[str, int] = {}
    for pid in pids or ():
        norm = idx.norms.get(pid)
        if not norm:
            out[pid] = 0
            continue
        toks = idx.toks.get(pid) or frozenset()
        cand = idx.candidates(toks, len(norm), threshold, exclude=(pid,))
        n = 0
        for cid in cand:
            if cid == pid:
                continue
            pair = (pid, cid) if pid <= cid else (cid, pid)
            if pair in ign:
                continue
            if ratio(norm, idx.norms.get(cid, ""), threshold) >= threshold:
                n += 1
        out[pid] = n
    return out


# --------------------------------------------------------------------------
# All-pairs
# --------------------------------------------------------------------------


def _components(pairs: Dict[str, Dict[str, float]]) -> List[List[str]]:
    """Connected components over the similarity graph."""
    seen: Set[str] = set()
    groups: List[List[str]] = []
    for start in pairs:
        if start in seen or not pairs[start]:
            continue
        stack = [start]
        seen.add(start)
        comp: List[str] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nxt in pairs.get(cur, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        if len(comp) > 1:
            comp.sort()
            groups.append(comp)
    groups.sort(key=lambda g: (-len(g), g[0]))
    return groups


def _finish(pairs: Dict[str, Dict[str, float]], threshold: float,
            rev: Optional[int], exhaustive: bool) -> Dict[str, Any]:
    counts = {pid: len(nb) for pid, nb in pairs.items()}
    return {
        "rev": rev,
        "threshold": float(threshold),
        "exhaustive": bool(exhaustive),
        "counts": counts,
        "groups": _components(pairs),
        "pairs": pairs,
    }


def dupe_counts(source: Any, threshold: float = DEFAULT_THRESHOLD, *,
                rev: Optional[int] = None, exhaustive: bool = False,
                ignored: Iterable[Any] = ()) -> Dict[str, Any]:
    """All-pairs near-duplicate scan.

    Returns::

        {rev, threshold, exhaustive,
         counts: {pid: int},                 # near-dupe count per record
         groups: [[pid, ...], ...],          # connected components, size >= 2
         pairs:  {pid: {other: score}}}      # adjacency, used by patch()

    ``exhaustive=True`` skips blocking entirely (guaranteed-complete, O(n^2)
    cascades) for anyone willing to pay for it.
    """
    idx = _resolve(source, rev)
    ign = _norm_ignored(ignored)

    cache_key = None
    if idx.rev is not None and not ign:
        cache_key = (int(idx.rev), float(threshold), bool(exhaustive))
        with _lock:
            _stats["all_calls"] += 1
            hit = _lru_get(_all_cache, cache_key)
            if hit is not None:
                _stats["all_hits"] += 1
                return hit

    pids = list(idx.records.keys())
    pos = {p: i for i, p in enumerate(pids)}
    pairs: Dict[str, Dict[str, float]] = {p: {} for p in pids}

    for i, a in enumerate(pids):
        na = idx.norms.get(a, "")
        if not na:
            continue
        if exhaustive:
            cand = pids[i + 1:]
        else:
            toks = idx.toks.get(a) or frozenset()
            cand = [c for c in idx.candidates(toks, len(na), threshold, exclude=(a,))
                    if pos.get(c, -1) > i]
        for b in cand:
            if ign:
                pair = (a, b) if a <= b else (b, a)
                if pair in ign:
                    continue
            r = ratio(na, idx.norms.get(b, ""), threshold)
            if r >= threshold and r > 0.0:
                pairs[a][b] = r
                pairs[b][a] = r

    result = _finish(pairs, threshold, idx.rev, exhaustive)
    if cache_key is not None:
        with _lock:
            _lru_put(_all_cache, cache_key, result, ALL_CACHE_MAX)
    return result


def dupe_ids(result: Dict[str, Any]) -> Set[str]:
    """Ids with at least one near-duplicate -- feeds ``dupes_only``."""
    return {pid for pid, n in (result or {}).get("counts", {}).items() if n}


def patch(old_rec: Optional[Dict[str, Any]], new_rec: Optional[Dict[str, Any]],
          threshold: float = DEFAULT_THRESHOLD, *,
          old_rev: Optional[int] = None, new_rev: Optional[int] = None,
          source: Any = None, exhaustive: bool = False) -> Optional[Dict[str, Any]]:
    """Incrementally update a cached all-pairs result for one record write.

    ``old_rec`` is the pre-write record (``None`` for a create), ``new_rec``
    the post-write record (``None`` for a delete).  Returns the patched
    result re-keyed to ``new_rev``, or ``None`` when there is nothing cached
    to patch (the caller should then just call :func:`dupe_counts`).
    """
    pid = str((new_rec or old_rec or {}).get("id") or "")
    if not pid:
        return None

    with _lock:
        if old_rev is not None:
            base = _lru_get(_all_cache, (int(old_rev), float(threshold), bool(exhaustive)))
        else:
            base = None
            for key in reversed(_all_cache):
                if key[1] == float(threshold) and key[2] == bool(exhaustive):
                    base = _all_cache[key]
                    old_rev = key[0]
                    break
        if base is None:
            return None
        pairs = {p: dict(nb) for p, nb in base.get("pairs", {}).items()}

    idx = _resolve(source, old_rev) if source is not None else None

    # unlink the old record
    for other in list(pairs.get(pid, {})):
        pairs.get(other, {}).pop(pid, None)
    pairs.pop(pid, None)

    if new_rec is not None:
        if idx is None:
            return None
        idx.replace(new_rec)
        if new_rev is not None:
            idx.rev = int(new_rev)
        norm = idx.norms.get(pid, "")
        pairs[pid] = {}
        if norm:
            toks = idx.toks.get(pid) or frozenset()
            if exhaustive:
                cand = [c for c in idx.records if c != pid]
            else:
                cand = idx.candidates(toks, len(norm), threshold, exclude=(pid,))
            for other in cand:
                if other == pid or other not in pairs:
                    continue
                r = ratio(norm, idx.norms.get(other, ""), threshold)
                if r >= threshold and r > 0.0:
                    pairs[pid][other] = r
                    pairs[other][pid] = r
    elif idx is not None:
        idx.remove(pid)
        if new_rev is not None:
            idx.rev = int(new_rev)

    result = _finish(pairs, threshold, new_rev, exhaustive)
    if new_rev is not None:
        with _lock:
            _lru_put(_all_cache, (int(new_rev), float(threshold), bool(exhaustive)),
                     result, ALL_CACHE_MAX)
    return result


# --------------------------------------------------------------------------
# Word-level diff
# --------------------------------------------------------------------------


def _tok_pairs(text: Any) -> Tuple[List[str], List[str]]:
    """``(display_tokens, match_keys)``.

    Display tokens keep original casing and punctuation; keys are NFKC +
    casefold with surrounding punctuation stripped, so ``Camera,`` matches
    ``camera`` while the rendered diff still shows the real text.
    """
    if not text:
        return [], []
    if not isinstance(text, str):
        text = str(text)
    display = _WS_TOKEN_RE.findall(text)
    keys: List[str] = []
    for tokn in display:
        k = unicodedata.normalize("NFKC", tokn).casefold()
        stripped = _EDGE_PUNCT_RE.sub("", k)
        keys.append(stripped if stripped else k)
    return display, keys


def diff_tokens(a: Any, b: Any, cap: int = DIFF_OPCODE_CAP) -> List[Dict[str, Any]]:
    """Full word-level opcodes, ``equal`` runs included, capped at ``cap``.

    ``[{op, a_start, a_end, b_start, b_end, a_tokens, b_tokens}]`` -- one
    entry per opcode so the compare modal can render a chunk into *each*
    column even when one side is empty.
    """
    a_disp, a_keys = _tok_pairs(a)
    b_disp, b_keys = _tok_pairs(b)
    # autojunk=False: with the default, tokens repeated in >1% of a >=200
    # token sequence (every "the", every comma-suffixed word) become junk and
    # the opcode stream degenerates. Do not remove.
    sm = difflib.SequenceMatcher(None, a_keys, b_keys, autojunk=False)
    out: List[Dict[str, Any]] = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        out.append({
            "op": op,
            "a_start": i1, "a_end": i2,
            "b_start": j1, "b_end": j2,
            "a_tokens": a_disp[i1:i2],
            "b_tokens": b_disp[j1:j2],
        })
        if len(out) >= cap:
            break
    return out


def _span(tokens: Sequence[str]) -> str:
    if len(tokens) > SUMMARY_MAX_TOKENS:
        return " ".join(tokens[:SUMMARY_MAX_TOKENS]) + ELLIPSIS
    return " ".join(tokens)


def diff_summary(a: Any, b: Any, max_changes: int = SUMMARY_MAX_CHANGES) -> str:
    """Human summary of the non-equal opcodes.

    ``"toward" -> "towards", + volumetric haze`` (curly quotes, U+2192
    arrow).  The ``differs: `` prefix belongs to the UI, not to this payload.
    """
    changes: List[str] = []
    total = 0
    for chunk in diff_tokens(a, b):
        op = chunk["op"]
        if op == "equal":
            continue
        total += 1
        if len(changes) >= max_changes:
            continue
        if op == "replace":
            changes.append("%s%s%s %s %s%s%s" % (
                LQUO, _span(chunk["a_tokens"]), RQUO, ARROW,
                LQUO, _span(chunk["b_tokens"]), RQUO))
        elif op == "insert":
            changes.append("+ " + _span(chunk["b_tokens"]))
        elif op == "delete":
            changes.append("- " + _span(chunk["a_tokens"]))
    if not changes:
        return ""
    out = ", ".join(changes)
    extra = total - len(changes)
    if extra > 0:
        out += ", +%d more" % extra
    return out


def compare(a_text: Any, b_text: Any,
            max_changes: int = SUMMARY_MAX_CHANGES) -> Dict[str, Any]:
    """``{score, pct, summary, diff}`` for the compare/merge dialog."""
    score = ratio(sim_norm(a_text), sim_norm(b_text), 0.0)
    return {
        "score": round(score, 6),
        "pct": int(round(score * 100)),
        "summary": diff_summary(a_text, b_text, max_changes=max_changes),
        "diff": diff_tokens(a_text, b_text),
    }
