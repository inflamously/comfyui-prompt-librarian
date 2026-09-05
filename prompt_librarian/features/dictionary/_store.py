"""``wordnet.sqlite3``: the converted dictionary, written once, then read-only."""

import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import closing, contextmanager

FILE_NAME = "wordnet.sqlite3"
VERSION = 1

SCHEMA = """
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE synsets (key TEXT PRIMARY KEY, pos TEXT NOT NULL, definition TEXT NOT NULL,
    examples TEXT NOT NULL, words TEXT NOT NULL);
CREATE TABLE senses (lemma TEXT NOT NULL, pos TEXT NOT NULL, rank INTEGER NOT NULL,
    key TEXT NOT NULL, antonyms TEXT NOT NULL);
CREATE TABLE lemmas (lemma TEXT PRIMARY KEY, senses INTEGER NOT NULL);
CREATE TABLE forms (form TEXT PRIMARY KEY, lemma TEXT NOT NULL);
"""
INDEXES = "CREATE INDEX senses_lemma ON senses (lemma, rank);"


def path(root: str) -> str:
    """Where the converted dictionary lives inside ``root``."""
    return os.path.join(root, FILE_NAME)


def installed(root: str) -> bool:
    """True once a complete conversion has been renamed into place."""
    return os.path.isfile(path(root))


@contextmanager
def read(root: str) -> Iterator[sqlite3.Connection]:
    """A read-only connection; rows come back as ``sqlite3.Row``."""
    uri = "file:" + path(root).replace("\\", "/") + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as con:
        con.row_factory = sqlite3.Row
        yield con


def loads(text: str) -> list[str]:
    """A stored JSON list, tolerating damage as empty."""
    try:
        value = json.loads(text)
    except ValueError:
        return []
    return [str(v) for v in value] if isinstance(value, list) else []
