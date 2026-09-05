"""Look one word up: a few plain definitions per part of speech, with examples."""

import sqlite3

from . import _morphy, _store

MAX_DEFINITIONS = 3
#: Things and their qualities come first: that is what an image prompt describes.
PART_ORDER = {"noun": 0, "adjective": 1, "verb": 2, "adverb": 3}
MAX_RELATED = 8
#: Related words come from this many leading senses; later ones are rare uses.
RELATED_SENSES = 5

SENSES_SQL = """SELECT senses.lemma, senses.pos, senses.rank, senses.antonyms,
        synsets.definition, synsets.examples, synsets.words
    FROM senses JOIN synsets ON synsets.key = senses.key
    WHERE senses.lemma = ? ORDER BY senses.rank"""


def normalize(word: object) -> str:
    """The key a word is looked up under: whitespace collapsed, lower case."""
    return " ".join(str(word or "").replace("_", " ").split()).lower()


def define(root: str, word: str) -> dict[str, object]:
    """The word's meanings from the downloaded dictionary.

    Args:
        root: The dictionary directory.
        word: Any spelling; plurals and other inflections find their base form.

    Returns:
        ``{"word", "status", "lemma", "meanings", "parts", "source"}``.
        ``status`` is ``found``, ``missing`` or ``not_installed``; ``lemma`` is
        the base form that was found ("forests" -> "forest"); ``parts`` lists
        the words of a missing phrase that the dictionary does know.

    Raises:
        ValueError: The word is empty.
    """
    key = normalize(word)
    if not key:
        raise ValueError("word is empty")
    if not _store.installed(root):
        return _answer(key, "not_installed")
    try:
        with _store.read(root) as con:
            base, rows = _senses(con, key)
            source = _source(con)
            parts = [] if rows else _known_parts(con, key)
    except sqlite3.Error:
        return _answer(key, "not_installed")
    if not rows:
        return {**_answer(key, "missing", source=source), "parts": parts}
    found = _answer(key, "found", source=source)
    return {**found, "lemma": base, "meanings": _meanings(rows, base)}


def _answer(key: str, status: str, source: str = "") -> dict[str, object]:
    return {"word": key, "status": status, "lemma": "", "meanings": [], "parts": [],
            "source": source}


def _senses(con: sqlite3.Connection, key: str) -> tuple[str, list[sqlite3.Row]]:
    """The first spelling that has senses: the word, an irregular form's base, a suffix rule."""
    irregular = con.execute("SELECT lemma FROM forms WHERE form = ?", (key,)).fetchone()
    tries = [key, *([irregular["lemma"]] if irregular else []), *_morphy.candidates(key)[1:]]
    for base in dict.fromkeys(tries):
        rows = con.execute(SENSES_SQL, (base,)).fetchall()
        if rows:
            return base, rows
    return key, []


def _known_parts(con: sqlite3.Connection, key: str) -> list[str]:
    """The words of a phrase ("golden hour") that have an entry of their own."""
    words = key.split()
    if len(words) < 2:
        return []
    return [w for w in dict.fromkeys(words) if _senses(con, w)[1]]


def _source(con: sqlite3.Connection) -> str:
    row = con.execute("SELECT v FROM meta WHERE k = 'source'").fetchone()
    return row["v"] if row else ""


def _meanings(rows: list[sqlite3.Row], base: str) -> list[dict[str, object]]:
    """One entry per part of speech: nouns, adjectives, verbs, adverbs."""
    parts: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        parts.setdefault(row["pos"], []).append(row)
    ordered = sorted(parts.items(), key=lambda item: PART_ORDER.get(item[0], len(PART_ORDER)))
    return [_meaning(pos, senses, base) for pos, senses in ordered]


def _meaning(pos: str, senses: list[sqlite3.Row], base: str) -> dict[str, object]:
    top = senses[:MAX_DEFINITIONS]
    common = senses[:RELATED_SENSES]
    synonyms = [w for row in common for w in _store.loads(row["words"]) if w != base]
    antonyms = [w for row in common for w in _store.loads(row["antonyms"])]
    return {
        "part": pos,
        "definitions": [row["definition"] for row in top],
        "examples": [next(iter(_store.loads(row["examples"])), "") for row in top],
        "synonyms": list(dict.fromkeys(synonyms))[:MAX_RELATED],
        "antonyms": list(dict.fromkeys(antonyms))[:MAX_RELATED],
    }
