"""Which words have a picture, at what version, and from where."""

import os

from . import _index


def list_word_images(root: str) -> dict[str, dict[str, object]]:
    """``{word: {"version", "source", "page"}}`` for every thumbnail on disk."""
    return {
        word: _index.public(entry)
        for word, entry in _index.read_index(root).items()
        if os.path.isfile(os.path.join(root, _index.file_name(word)))
    }


def word_image_entry(root: str, word: str) -> dict[str, object] | None:
    """One word's public entry, or ``None`` when it has no picture."""
    return list_word_images(root).get(_index.normalize(word))
