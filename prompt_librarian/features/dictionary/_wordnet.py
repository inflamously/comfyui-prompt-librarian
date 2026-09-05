"""Read the WordNet 3.0 database files (``data.*``, ``index.*``, ``*.exc``).

Format: https://wordnet.princeton.edu/documentation/wndb5wn. Only what the
gallery shows is kept: each synset's words, definition and examples, the
antonym pointers, and each lemma's senses in frequency order.
"""

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field

#: WordNet file suffix -> part of speech, as the gallery names it.
POS = {"noun": "noun", "verb": "verb", "adj": "adjective", "adv": "adverb"}
#: The pointer letter each file's synsets use; satellites (``s``) live with ``a``.
POS_LETTER = {"noun": "n", "verb": "v", "adj": "a", "adv": "r"}

_MARKER = re.compile(r"\((?:a|p|ip)\)$")  # adjective position markers: galore(ip)
_EXAMPLE = re.compile(r'"([^"]*)"')


@dataclass
class Synset:
    """One meaning: the words that share it, what it means, and its pointers."""

    key: str
    pos: str
    satellite: bool
    words: list[str]
    definition: str
    examples: list[str]
    #: ``(symbol, target key, source word index, target word index)``; 0 = whole synset.
    pointers: list[tuple[str, str, int, int]] = field(default_factory=list)


def lemma(word: str) -> str:
    """A WordNet spelling as people type it: spaces, lower case, no markers."""
    return _MARKER.sub("", word).replace("_", " ").lower()


def parse_data(letter: str, pos: str, lines: Iterable[str]) -> Iterator[Synset]:
    """Every synset in one ``data.<pos>`` file; the licence header is skipped."""
    for line in lines:
        if line.startswith(" ") or not line.strip():
            continue
        yield _synset(letter, pos, line)


def _synset(letter: str, pos: str, line: str) -> Synset:
    head, _, gloss = line.partition(" | ")
    fields = head.split()
    count = int(fields[3], 16)
    words = [lemma(fields[4 + 2 * i]) for i in range(count)]
    at = 4 + 2 * count
    pointers = []
    for k in range(int(fields[at])):
        symbol, offset, target_pos, st = fields[at + 1 + 4 * k: at + 5 + 4 * k]
        target = _key("a" if target_pos == "s" else target_pos, offset)
        pointers.append((symbol, target, int(st[:2], 16), int(st[2:], 16)))
    definition, examples = _gloss(gloss)
    return Synset(_key(letter, fields[0]), pos, fields[2] == "s", words, definition, examples,
                  pointers)


def _gloss(gloss: str) -> tuple[str, list[str]]:
    """``definition; "example"; "example"`` -> the definition and the examples."""
    gloss = gloss.strip()
    definition = gloss.split('; "', 1)[0].split(' "', 1)[0].strip().rstrip(";").strip()
    return definition, [e.strip() for e in _EXAMPLE.findall(gloss) if e.strip()]


def _key(letter: str, offset: str) -> str:
    return f"{letter}{offset}"


def parse_index(letter: str, lines: Iterable[str]) -> Iterator[tuple[str, list[str]]]:
    """``(lemma, synset keys, most frequent sense first)`` for one ``index.<pos>`` file."""
    for line in lines:
        if line.startswith(" ") or not line.strip():
            continue
        fields = line.split()
        senses = int(fields[2])
        pointer_count = int(fields[3])
        offsets = fields[4 + pointer_count + 2:][:senses]
        yield lemma(fields[0]), [_key(letter, o) for o in offsets]


def parse_exceptions(lines: Iterable[str]) -> Iterator[tuple[str, str]]:
    """``(irregular form, base form)`` pairs from one ``<pos>.exc`` file."""
    for line in lines:
        fields = line.split()
        if len(fields) >= 2:
            yield lemma(fields[0]), lemma(fields[1])
