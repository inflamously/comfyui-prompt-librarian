"""The word index, the miss list and the file naming shared by the use-cases.

``index.json`` maps word -> ``{"v", "src", "page", "size", "pics"}``: the
version that busts the browser cache, where the first picture came from
(``manual`` or ``generated``), the web page it represents, its size in bytes,
and the word's pictures in order (see ``_pictures``).
``misses.json`` maps word -> when its picture was removed; the generator skips those.
"""

import hashlib
import json
import os
import tempfile
import threading

INDEX_NAME = "index.json"
MISSES_NAME = "misses.json"

# Writers run on executor threads; both files are read-modify-write.
LOCK = threading.Lock()


def normalize(word: object) -> str:
    """The key a word is stored under: whitespace collapsed, lower case."""
    return " ".join(str(word or "").split()).lower()


def file_name(key: str) -> str:
    """Thumbnail file name for a normalized word; safe for any input."""
    return hashlib.sha1(key.encode("utf-8")).hexdigest() + ".webp"  # noqa: S324 - a name, not a secret


def read_index(root: str) -> dict[str, dict]:
    """Word -> entry; a missing or damaged index reads as empty."""
    data = _read_json(os.path.join(root, INDEX_NAME))
    return {
        str(k): v for k, v in data.items() if isinstance(v, dict) and isinstance(v.get("v"), int)
    }


def read_misses(root: str) -> dict[str, float]:
    """Word -> epoch seconds when the user removed its picture."""
    data = _read_json(os.path.join(root, MISSES_NAME))
    return {str(k): float(v) for k, v in data.items() if isinstance(v, (int, float))}


def write_index(root: str, index: dict[str, dict]) -> None:
    """Replace the index atomically."""
    _write_json(os.path.join(root, INDEX_NAME), index)


def write_misses(root: str, misses: dict[str, float]) -> None:
    """Replace the miss list atomically."""
    _write_json(os.path.join(root, MISSES_NAME), misses)


def public(entry: dict) -> dict[str, object]:
    """What clients see of an entry: version, source, page and its pictures in order."""
    pics = entry.get("pics")
    if not isinstance(pics, list):  # written before words had several pictures
        pics = [{"id": "1", "v": entry["v"], "src": entry.get("src", "")}]
    return {
        "version": entry["v"], "source": entry.get("src", ""), "page": entry.get("page", ""),
        "pictures": [{"id": p["id"], "version": p.get("v", entry["v"]), "source": p.get("src", "")}
                     for p in pics if isinstance(p, dict) and p.get("id")],
    }


def write_atomic(path: str, data: bytes) -> None:
    """Write ``data`` to a temp file beside ``path``, then rename over it."""
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: str, data: dict) -> None:
    write_atomic(path, json.dumps(data, ensure_ascii=False, sort_keys=True).encode("utf-8"))
