"""Rearrange a word's pictures."""

from ...shared.errors import NotFoundError
from . import _index, _pictures


def order_word_images(root: str, word: str, ids: list[str]) -> dict[str, object]:
    """Put the word's pictures in the order of ``ids`` and rebuild its mosaic.

    Ids that are not the word's are ignored; pictures left out keep their
    relative order after the listed ones, so a stale client loses nothing.

    Raises:
        NotFoundError: The word has no pictures.
    """
    key = _index.normalize(word)
    with _index.LOCK:
        index = _index.read_index(root)
        pics = _pictures.pictures(root, key, index.get(key))
        if not pics:
            raise NotFoundError("no picture for that word")
        rank = {picture_id: i for i, picture_id in enumerate(dict.fromkeys(map(str, ids)))}
        pics.sort(key=lambda p: rank.get(p["id"], len(rank)))
        saved = _pictures.save(root, key, pics, index)
        _index.write_index(root, index)
    return saved
