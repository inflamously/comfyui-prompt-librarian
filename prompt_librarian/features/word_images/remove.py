"""Remove a word's pictures, or one of them."""

import os
import time

from . import _index, _pictures


def remove_word_image(root: str, word: str, picture_id: str = "") -> bool:
    """Delete one picture of ``word`` (by id), or all of them; returns whether anything went.

    When the word is left without pictures it is recorded as skipped, so the
    batch generator does not make a removed picture again.
    """
    key = _index.normalize(word)
    with _index.LOCK:
        index = _index.read_index(root)
        pics = _pictures.pictures(root, key, index.get(key))
        keep = [p for p in pics if picture_id and p["id"] != picture_id]
        for picture in pics:
            if picture not in keep:
                _pictures.drop_file(root, key, picture["id"])
        existed = len(keep) < len(pics)
        if existed:
            _pictures.save(root, key, keep, index)
            _index.write_index(root, index)
        main = os.path.join(root, _index.file_name(key))
        if not keep and os.path.exists(main):
            os.unlink(main)
            existed = True
        if existed and not keep:
            misses = _index.read_misses(root)
            misses[key] = time.time()
            _index.write_misses(root, misses)
    return existed
