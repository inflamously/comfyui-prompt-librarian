"""A word's pictures: up to nine thumbnails, kept in order, shown as one mosaic.

Each picture is its own file (``<sha1>-<id>.webp``). The word's main file
(``<sha1>.webp``, what previews and tiles load) is the single picture itself,
or the mosaic of all of them, rebuilt on every change. Entries written before
pictures were lists have no ``pics``: their main file is their one picture,
known as :data:`LEGACY_ID` and copied out on the first change.
"""

import os
import secrets
import time

from . import _index
from ._mosaic import compose

MAX_PICTURES = 9
LEGACY_ID = "1"


def picture_file(key: str, picture_id: str) -> str:
    """File name of one picture of a normalized word."""
    return _index.file_name(key)[: -len(".webp")] + f"-{picture_id}.webp"


def pictures(root: str, key: str, entry: dict | None) -> list[dict]:
    """The word's pictures in order; a legacy entry is moved to its own picture file.

    The caller holds :data:`_index.LOCK`.
    """
    if not entry:
        return []
    if isinstance(entry.get("pics"), list):
        return [dict(p) for p in entry["pics"] if isinstance(p, dict) and p.get("id")]
    main = os.path.join(root, _index.file_name(key))
    if not os.path.isfile(main):
        return []
    with open(main, "rb") as handle:
        _index.write_atomic(os.path.join(root, picture_file(key, LEGACY_ID)), handle.read())
    return [{"id": LEGACY_ID, "v": entry["v"], "src": entry.get("src", ""),
             "size": entry.get("size", 0)}]


def new_picture(root: str, key: str, data: bytes, src: str) -> dict:
    """Write one picture file and return its entry (not yet in the index)."""
    picture_id = secrets.token_hex(4)
    _index.write_atomic(os.path.join(root, picture_file(key, picture_id)), data)
    return {"id": picture_id, "v": time.time_ns() // 1_000_000, "src": src, "size": len(data)}


def save(root: str, key: str, pics: list[dict], index: dict[str, dict]) -> dict[str, object]:
    """Rebuild the main file from ``pics`` and record the entry in ``index``.

    With no pictures left the word is dropped. The caller holds
    :data:`_index.LOCK` and writes ``index`` afterwards.

    Returns:
        The public entry with its word, or ``{}`` when the word has no pictures.
    """
    main = os.path.join(root, _index.file_name(key))
    if not pics:
        index.pop(key, None)
        if os.path.exists(main):
            os.unlink(main)
        return {}
    data = _read(root, key, pics)
    shown = data[0] if len(data) == 1 else compose(data)
    _index.write_atomic(main, shown)
    previous = index.get(key, {})
    entry = {
        "v": max(time.time_ns() // 1_000_000, previous.get("v", 0) + 1),
        "src": pics[0].get("src", ""), "page": previous.get("page", ""),
        "size": len(shown) + sum(p.get("size", 0) for p in pics), "pics": pics,
    }
    index[key] = entry
    return {"word": key, **_index.public(entry)}


def _read(root: str, key: str, pics: list[dict]) -> list[bytes]:
    out = []
    for picture in pics:
        with open(os.path.join(root, picture_file(key, picture["id"])), "rb") as handle:
            out.append(handle.read())
    return out


def drop_file(root: str, key: str, picture_id: str) -> None:
    """Delete one picture's file, if it is there."""
    path = os.path.join(root, picture_file(key, picture_id))
    if os.path.exists(path):
        os.unlink(path)
