"""Find the file for one word: its shown picture, or one picture by id."""

import os

from . import _index, _pictures


def word_image_path(root: str, word: str, picture_id: str = "") -> str | None:
    """Absolute path of the word's shown image (or of picture ``picture_id``), else ``None``."""
    key = _index.normalize(word)
    if not key:
        return None
    main = os.path.join(root, _index.file_name(key))
    if picture_id:
        path = os.path.join(root, _pictures.picture_file(key, os.path.basename(picture_id)))
        if not os.path.isfile(path) and picture_id == _pictures.LEGACY_ID:
            path = main  # written before words had several pictures
    else:
        path = main
    return path if os.path.isfile(path) else None
