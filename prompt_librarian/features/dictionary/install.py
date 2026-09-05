"""Download WordNet once and convert it into ``wordnet.sqlite3``."""

import io
import json
import os
import sqlite3
import tempfile
import threading
import zipfile
from collections.abc import Callable, Iterable
from contextlib import closing

from . import _store, _wordnet
from ._wordnet import Synset
from .http import HttpGet, ServiceUnavailableError, http_get
from .status import dictionary_status

#: Princeton WordNet 3.0, as the NLTK project redistributes it.
URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip"
SOURCE = "WordNet 3.0, Princeton University"

_LOCK = threading.Lock()


def install(root: str, get: HttpGet = http_get) -> dict[str, object]:
    """Download and convert the dictionary, unless it is already there.

    Args:
        root: The dictionary directory.
        get: The HTTP GET to use (tests pass a fake).

    Returns:
        The new :func:`dictionary_status`.

    Raises:
        ServiceUnavailableError: The download failed; nothing was written.
        ValueError: The download was not a WordNet archive.
    """
    with _LOCK:
        if _store.installed(root):
            return dictionary_status(root)
        _status, body = get(URL)
        try:
            archive = zipfile.ZipFile(io.BytesIO(body))
        except zipfile.BadZipFile as exc:
            raise ServiceUnavailableError("the download was not a zip archive") from exc
        with archive:
            convert(archive, root)
        return dictionary_status(root)


def convert(archive: zipfile.ZipFile, root: str) -> None:
    """Build the database in a temp file beside the target, then rename it in."""
    files = {os.path.basename(n): n for n in archive.namelist()}
    missing = [f"data.{p}" for p in _wordnet.POS if f"data.{p}" not in files]
    if missing:
        raise ValueError(f"not a WordNet archive: {', '.join(missing)} missing")

    def lines(name: str) -> Iterable[str]:
        if name not in files:
            return []
        return archive.read(files[name]).decode("utf-8", errors="replace").splitlines()

    os.makedirs(root, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=root, suffix=".tmp")
    os.close(fd)
    try:
        with closing(sqlite3.connect(tmp)) as con:
            # A throwaway build file renamed in only when complete needs no
            # journal; a rollback journal also fails on some network mounts.
            con.execute("PRAGMA journal_mode = OFF")
            con.execute("PRAGMA synchronous = OFF")
            _fill(con, lines)
            con.commit()
        os.replace(tmp, _store.path(root))
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _fill(con: sqlite3.Connection, lines: Callable[[str], Iterable[str]]) -> None:
    con.executescript(_store.SCHEMA)
    synsets = {}
    for suffix, pos in _wordnet.POS.items():
        letter = _wordnet.POS_LETTER[suffix]
        for synset in _wordnet.parse_data(letter, pos, lines(f"data.{suffix}")):
            synsets[synset.key] = synset
    con.executemany("INSERT INTO synsets VALUES (?, ?, ?, ?, ?)", (
        (s.key, s.pos, s.definition, json.dumps(s.examples), json.dumps(s.words))
        for s in synsets.values()))
    counts: dict[str, int] = {}
    for suffix, pos in _wordnet.POS.items():
        letter = _wordnet.POS_LETTER[suffix]
        for word, keys in _wordnet.parse_index(letter, lines(f"index.{suffix}")):
            counts[word] = counts.get(word, 0) + len(keys)
            con.executemany("INSERT INTO senses VALUES (?, ?, ?, ?, ?)", (
                (word, pos, rank, key, json.dumps(antonyms(synsets, key, word)))
                for rank, key in enumerate(keys) if key in synsets))
        con.executemany("INSERT OR IGNORE INTO forms VALUES (?, ?)",
                        _wordnet.parse_exceptions(lines(f"{suffix}.exc")))
    con.executemany("INSERT INTO lemmas VALUES (?, ?)", counts.items())
    con.executescript(_store.INDEXES)
    con.executemany("INSERT INTO meta VALUES (?, ?)", (
        ("version", str(_store.VERSION)), ("source", SOURCE), ("words", str(len(counts)))))


def antonyms(synsets: dict[str, Synset], key: str, word: str) -> list[str]:
    """Opposites of ``word`` in this sense.

    Direct antonym pointers come first. A satellite adjective ("misty") has
    none of its own, so it borrows the opposites of its head ("dark").
    """
    synset = synsets[key]
    found = _direct(synsets, synset, word)
    if not found and synset.satellite:
        for symbol, target, _source, _target in synset.pointers:
            head = synsets.get(target)
            if symbol == "&" and head is not None:
                found = [w for h in head.words for w in _direct(synsets, head, h)]
    return list(dict.fromkeys(found))


def _direct(synsets: dict[str, Synset], synset: Synset, word: str) -> list[str]:
    index = synset.words.index(word) + 1 if word in synset.words else -1
    out = []
    for symbol, target, source, target_word in synset.pointers:
        other = synsets.get(target)
        if symbol != "!" or other is None or source not in (0, index):
            continue
        out.extend(other.words if target_word == 0 else other.words[target_word - 1: target_word])
    return out
