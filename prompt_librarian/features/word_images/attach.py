"""Attach an image ComfyUI produced to one or more words, as one more picture each."""

import os

from ...shared.errors import NotFoundError
from . import _index, _pictures
from ._thumb import make_thumbnail

SOURCES = ("manual", "generated")


def attach_word_image(
    root: str, words: str | list[str], source: str, kind: str = "manual"
) -> dict[str, object]:
    """Add a thumbnail of ``source`` to each word's pictures (at most nine per word).

    Args:
        root: The word-images directory.
        words: One word or phrase, or several; each is normalized before storing.
        source: Path of an existing image file.
        kind: ``generated`` by the batch generator, or ``manual``.

    Returns:
        The first word's public entry (``word``, ``version``, ``source``,
        ``page``, ``pictures``), plus ``words``: every updated entry, and
        ``skipped``: the words that already had nine pictures.

    Raises:
        ValueError: No word given, every word is full, or the file is not a readable image.
        NotFoundError: ``source`` does not exist.
    """
    keys = list(dict.fromkeys(k for k in map(_index.normalize, _as_list(words)) if k))
    if not keys:
        raise ValueError("word is empty")
    if not os.path.isfile(source):
        raise NotFoundError(f"image not found: {os.path.basename(source)}")
    data = make_thumbnail(source, os.path.basename(source))
    src = kind if kind in SOURCES else "manual"
    with _index.LOCK:
        index = _index.read_index(root)
        saved, skipped = [], []
        for key in keys:
            pics = _pictures.pictures(root, key, index.get(key))
            if len(pics) >= _pictures.MAX_PICTURES:
                skipped.append(key)
                continue
            pics.append(_pictures.new_picture(root, key, data, src))
            saved.append(_pictures.save(root, key, pics, index))
        if not saved:
            raise ValueError(f"already {_pictures.MAX_PICTURES} pictures: {', '.join(skipped)}")
        _index.write_index(root, index)
        _forget_misses(root, keys)
    return {**saved[0], "words": saved, "skipped": skipped}


def _as_list(words: str | list[str]) -> list[str]:
    return [words] if isinstance(words, str) else [str(w) for w in words or []]


def _forget_misses(root: str, keys: list[str]) -> None:
    """A word that has a picture again is no longer skipped by the generator."""
    misses = _index.read_misses(root)
    if any(misses.pop(key, None) is not None for key in list(keys)):
        _index.write_misses(root, misses)
