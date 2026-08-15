"""Derived labels — what a record is *called*, computed and never stored.

A record has no ``name``. There is no field to type one into, none on disk and
none in the api: a prompt **is** its body, and a name was only ever a second,
hand-maintained copy of what the body already said. It drifted from the body on
every edit, it was empty on most records, and finding a prompt by it meant
remembering what one had called it a month ago. The search bar does that job.

What is still needed is a *handle*: a few characters that let a list row, a
version row or a duplicate row stand for one prompt. That handle is derived
here, from two ingredients:

* **the corpus** — the terms that distinguish this body from every *other*
  body in the library, by tf-idf over the same tokens the search index already
  keeps. Two prompts that open with the same forty words of boilerplate still
  read apart, because the label is made of the words only one of them uses;
* **the body itself** — its opening words, used whenever the corpus has
  nothing to say (an empty library, a body of pure boilerplate, a caller with
  no index to hand).

The label is a *display* string and nothing else. Nothing is stored by it,
nothing is looked up by it, and it is free to change when the corpus around it
changes — which it does, and which is the point. Anything that needs identity
uses the record id, and anything that needs to *find* a record uses search.

Pure and stdlib-only, like :mod:`.search`, and one layer below it: the search
index owns the document frequencies, this module owns what to do with them.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Callable
from typing import Any

# --------------------------------------------------------------------------
# Tuning (module level, like search.py's: the shape of a label is a product
# decision, so it has to be inspectable and patchable from a test).
# --------------------------------------------------------------------------

LABEL_TERMS = 3          # distinctive terms to pick, before adjacency merging
LABEL_CHARS = 64         # hard cap on the rendered label
LABEL_SEP = " · "   # " · "
MIN_TERM_CHARS = 3       # ...for purely alphabetic terms; "8k" and "4k" survive
HEAD_CHARS = 64          # cap on the body-head fallback
ELLIPSIS = "…"

# Bodies are capped at 100 000 characters and a label is drawn from a handful
# of words, so the scan is bounded rather than run over a novel: a search page
# labels 50 records, and an unbounded scan would put the whole page's bodies
# through a regex on every keystroke.
LABEL_SCAN_CHARS = 4000

# Function words only. Everything domain-specific ("photo", "detailed", "8k")
# is left to idf, which is what the corpus is *for* — a library of photographic
# prompts should not have "photo" in every label, and one where a single prompt
# mentions it should.
#
# When a word is arguable, it is left OUT of this list. A word wrongly listed
# here can never appear in a label however distinctive it is; a word wrongly
# left out merely loses to rarer terms as soon as the library is big enough to
# have an opinion. So the spatial words that carry composition in prompt-speak
# — "under", "above", "below", "behind", "beneath" — are deliberately absent.
_STOPWORD_TEXT = """
a about after again against all along already also although always among an
and another any anything are around as at be because been before being both
but by can come comes could did do does doing done down during each either
else even ever every few for from get gets got had has have he her hers him
his how however i if in into is it its just like made make makes many may me
might more most much must my near neither never next no nor not now of off on
once one only onto or other others our ours out over own per put said same see
seen she should since so some still such take takes than that the their theirs
them then there therefore these they this those though through throughout thus
to together too toward towards until up upon us very via want was way we well
were what when whenever where whether which while who whom why will with
within without would yet you your yours
"""
STOPWORDS = frozenset(_STOPWORD_TEXT.split())

_WORD_RE = re.compile(r"\w+", re.UNICODE)
_WS_RE = re.compile(r"\s+", re.UNICODE)
_DIGIT_RE = re.compile(r"\d", re.UNICODE)
_NON_WORD_RE = re.compile(r"[^\w]+", re.UNICODE)

# What may sit between two picked terms and still leave them one phrase.
# Whitespace only: "ruined theatre" is a phrase, "ruined, theatre" is two
# terms that happen to be adjacent, and a newline is a change of subject.
_GLUE_RE = re.compile(r"[ \t]*\Z")

DocFreq = Callable[[str], int]


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return "" if value is None else str(value)


def term_tokens(word: str) -> tuple[str, ...]:
    """Fold one surface word into the tokens the search index posts under.

    NFKC, then ``casefold``, then split on non-word characters — the same
    three steps, in the same order, as :func:`search.normalize`. They have to
    agree exactly or every document frequency looked up here would miss.

    Usually one token in, one token out. It is a *tuple* because normalization
    can split a word that looked atomic: Turkish ``İ`` decomposes to ``i`` plus
    a combining dot, and the dot is not a word character, so ``İstanbul`` is
    posted as ``i`` + ``stanbul``. Such a word is scored by its rarest piece
    (see :func:`_pick_terms`), which is the piece that actually distinguishes
    the record.
    """
    folded = unicodedata.normalize("NFKC", word).casefold()
    return tuple(_NON_WORD_RE.sub(" ", folded).split())


def _key(pieces: tuple[str, ...]) -> str:
    return " ".join(pieces)


def _is_candidate(key: str) -> bool:
    """True when a term is allowed to appear in a label at all."""
    if not key or key in STOPWORDS:
        return False
    # Short *alphabetic* terms are noise ("at", "of"); short terms carrying a
    # digit are specifications ("8k", "f2", "35"), which is exactly the kind of
    # thing that tells two prompts apart.
    bare = key.replace(" ", "")
    return not (len(bare) < MIN_TERM_CHARS and not _DIGIT_RE.search(bare))


# --------------------------------------------------------------------------
# Document frequencies
# --------------------------------------------------------------------------


def document_frequency(records: Any) -> tuple[dict[str, int], int]:
    """``({term: docs containing it}, document count)`` over raw records.

    A standalone corpus pass, for callers with no search index to borrow from
    (tests, tools). :class:`search.SearchIndex` answers the same question from
    its postings for free, and the api always goes through that instead.
    """
    df: dict[str, int] = {}
    count = 0
    for rec in records or ():
        if not isinstance(rec, dict):
            continue
        count += 1
        seen = set()
        tags = rec.get("tags") or ()
        if isinstance(tags, str):
            tags = [tags]
        for chunk in (rec.get("body") or "", *(_text(t) for t in tags)):
            for match in _WORD_RE.finditer(chunk[:LABEL_SCAN_CHARS]):
                seen.update(term_tokens(match.group()))
        for token in seen:
            df[token] = df.get(token, 0) + 1
    return df, count


def _idf(df: int, ndocs: int) -> float:
    """Inverse document frequency, smoothed so it is never zero.

    ``df + 0.5`` rather than ``df + 1``: the unsmoothed form collapses to
    exactly 0.0 for a term that appears in *every* document, which in a
    one-record library is *every term* — and a library's first prompt would
    then be the only one that never gets a real label. Smoothed, a ubiquitous
    term still scores, just far below anything rarer, which is the ordering
    that was wanted in the first place.
    """
    return math.log((ndocs + 1) / (df + 0.5))


# --------------------------------------------------------------------------
# Labels
# --------------------------------------------------------------------------


def head_label(body: Any, chars: int = HEAD_CHARS) -> str:
    """The body's opening words, whitespace collapsed and cut on a word break.

    The fallback, and on its own the whole label for a corpus that cannot
    distinguish this body from any other.
    """
    flat = _WS_RE.sub(" ", _text(body)).strip()
    if len(flat) <= chars:
        return flat
    cut = flat[:chars]
    space = cut.rfind(" ")
    if space >= chars // 2:        # only honour a break that is not a stub
        cut = cut[:space]
    return cut.rstrip(" ,;:.-") + ELLIPSIS


def _occurrences(scan: str) -> list[tuple[int, int, str, tuple[str, ...]]]:
    """Every word of ``scan`` as ``(start, end, key, index tokens)``."""
    out = []
    for match in _WORD_RE.finditer(scan):
        pieces = term_tokens(match.group())
        out.append((match.start(), match.end(), _key(pieces), pieces))
    return out


def _df_of(pieces: tuple[str, ...], df: DocFreq) -> int:
    """Document frequency of a surface word: that of its *rarest* piece.

    One piece is the ordinary case and this is just its own frequency. When a
    word split, the rarest piece is the one carrying the distinguishing power,
    so it is the one that decides.
    """
    best = None
    for piece in pieces:
        try:
            seen = max(int(df(piece)), 0)
        except Exception:
            seen = 0
        if best is None or seen < best:
            best = seen
    return best or 0


def _pick_terms(occ: list[tuple[int, int, str, tuple[str, ...]]],
                df: DocFreq, ndocs: int) -> set[str]:
    """The ``LABEL_TERMS`` most distinctive terms of one body."""
    tf: dict[str, int] = {}
    first: dict[str, int] = {}
    pieces_of: dict[str, tuple[str, ...]] = {}
    for start, _end, key, pieces in occ:
        if not _is_candidate(key):
            continue
        tf[key] = tf.get(key, 0) + 1
        first.setdefault(key, start)
        pieces_of.setdefault(key, pieces)
    if not tf:
        return set()

    scored = []
    for key, count in tf.items():
        # Sub-linear tf: a body that says "ballerina" nine times is about
        # ballerinas, but not nine times as much as one that says it once.
        weight = (1.0 + math.log(count)) * _idf(_df_of(pieces_of[key], df), ndocs)
        scored.append((-weight, first[key], key))
    scored.sort()
    return {key for _w, _pos, key in scored[:LABEL_TERMS]}


def _phrases(scan: str, occ: list[tuple[int, int, str, tuple[str, ...]]],
             chosen: set[str]) -> list[str]:
    """Picked terms as body-ordered surface strings, adjacent ones merged.

    Two picked terms separated by nothing but blanks were one phrase in the
    body ("ruined theatre") and stay one in the label; anything else — a comma,
    a newline, a word that was not picked — ends the run.
    """
    out: list[str] = []
    seen: set[str] = set()
    run_start = run_end = None
    run_key: list[str] = []

    def _flush():
        nonlocal run_start, run_end, run_key
        if run_start is not None:
            key = " ".join(run_key)
            if key not in seen:
                seen.add(key)
                out.append(_WS_RE.sub(" ", scan[run_start:run_end]).strip())
        run_start = run_end = None
        run_key = []

    for start, end, key, _pieces in occ:
        if key not in chosen:
            _flush()
            continue
        if run_start is not None and _GLUE_RE.match(scan, run_end, start):
            run_end = end                      # glued to the run: one phrase
            run_key.append(key)
            continue
        _flush()
        run_start, run_end, run_key = start, end, [key]
    _flush()
    return out


def _render(phrases: list[str], chars: int) -> str:
    """Join phrases with ``·`` while they fit; never return an empty string."""
    out = ""
    for phrase in phrases:
        candidate = phrase if not out else out + LABEL_SEP + phrase
        if len(candidate) > chars:
            break
        out = candidate
    if out:
        return out
    return head_label(phrases[0], chars) if phrases else ""


def label_for(body: Any, df: DocFreq | None = None, ndocs: int = 0,
              chars: int = LABEL_CHARS) -> str:
    """A short display handle for ``body``, drawn from the corpus around it.

    ``df`` answers "how many records contain this term" and ``ndocs`` is how
    many records there are; :meth:`search.SearchIndex.label_of` supplies both
    from postings it already has. Without them — or when the body has no term
    the corpus can distinguish — the label is the body's opening words.

    Returns ``""`` for an empty body. Callers render their own placeholder:
    what an empty prompt should be called is a question about the surface it is
    shown on, not about the prompt.
    """
    text = _text(body)
    if not text.strip():
        return ""
    if df is None or ndocs <= 0:
        return head_label(text, chars)
    scan = text[:LABEL_SCAN_CHARS]
    occ = _occurrences(scan)
    chosen = _pick_terms(occ, df, ndocs)
    if not chosen:
        return head_label(text, chars)
    return _render(_phrases(scan, occ, chosen), chars) or head_label(text, chars)


def label_for_records(records: Any) -> dict[str, str]:
    """``{id: label}`` for a standalone iterable of records.

    One corpus pass shared by every label, for tools and tests. The api never
    calls this: it labels through the live search index instead, which already
    holds the frequencies and is already keyed on the store revision.
    """
    items = [rec for rec in (records or ()) if isinstance(rec, dict)]
    df, ndocs = document_frequency(items)
    return {str(rec.get("id") or ""): label_for(rec.get("body") or "", df.get, ndocs)
            for rec in items}
