"""Safe wildcard file lookup, directory signatures, and the mtime cache."""

import hashlib
import os
import re

from .sources import _default_wildcards_dir

WILDCARD_EXT = ".txt"


def _safe_name(name):
    """Reject a wildcard name that could escape the wildcards directory.

    Checked *before* any filesystem call: ``..`` anywhere, an absolute or
    root-relative path, a Windows drive letter or a UNC prefix. The
    ``realpath`` + ``commonpath`` containment check in
    :meth:`WildcardFiles.path_for` is the second half of the guard, catching
    symlinks that point outside.
    """
    if not name or "\x00" in name:
        return None
    cleaned = name.replace("\\", "/").strip()
    if not cleaned:
        return None
    if cleaned.startswith("/") or cleaned.startswith("//"):
        return None
    if re.match(r"^[A-Za-z]:", cleaned):  # C:\..., C:/...
        return None
    parts = [p for p in cleaned.split("/") if p not in ("", ".")]
    if not parts:
        return None
    if any(p == ".." for p in parts):
        return None
    if any(p.endswith(".") or p.endswith(" ") for p in parts):  # Windows oddities
        return None
    return "/".join(parts)


def _parse_options(raw_text):
    """Lines of a wildcard file: blanks and ``#`` comments dropped, ``\\r`` stripped."""
    out = []
    for line in raw_text.split("\n"):
        line = line.replace("\r", "").strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


class WildcardFiles:
    """Mtime-keyed cache over the wildcards directory.

    ``root`` may be a path, a zero-argument callable, or ``None`` (resolve the
    store's wildcards directory lazily at first use). Nothing here touches the
    filesystem until a lookup actually happens.
    """

    def __init__(self, root=None):
        self._root = root
        self._cache = {}  # name -> (mtime_ns, size, [options])

    # -- paths ------------------------------------------------------------- #

    def root(self):
        """The wildcards directory this instance reads from."""
        if callable(self._root):
            return self._root()
        if self._root:
            return self._root
        return _default_wildcards_dir()

    def path_for(self, name):
        """Absolute path of ``name``'s ``.txt`` file, or ``None`` when unsafe.

        Two-stage guard: :func:`_safe_name` rejects the obvious traversals up
        front, then ``realpath`` + ``commonpath`` proves the resolved file
        really sits inside the wildcards directory (which is what catches a
        symlink pointing out of it).
        """
        safe = _safe_name(name)
        if safe is None:
            return None
        root = self.root()
        candidate = os.path.join(root, *safe.split("/"))
        if not candidate.lower().endswith(WILDCARD_EXT):
            candidate += WILDCARD_EXT
        try:
            real_root = os.path.realpath(root)
            real_path = os.path.realpath(candidate)
            if os.path.commonpath([real_root, real_path]) != real_root:
                return None
        except (OSError, ValueError):
            # ValueError: commonpath across drives on Windows.
            return None
        return real_path

    # -- lookups ----------------------------------------------------------- #

    def options(self, name):
        """Options for ``name``, or ``None`` when the file is missing/unsafe.

        Cached on ``(st_mtime_ns, st_size)``, so an unchanged file is one
        ``os.stat`` per lookup and an edited one is picked up immediately.
        """
        path = self.path_for(name)
        if path is None:
            return None
        try:
            st = os.stat(path)
        except OSError:
            self._cache.pop(name, None)
            return None
        sig = (st.st_mtime_ns, st.st_size)
        hit = self._cache.get(name)
        if hit is not None and hit[0] == sig[0] and hit[1] == sig[1]:
            return hit[2]
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                raw = handle.read()
        except OSError:
            self._cache.pop(name, None)
            return None
        options = _parse_options(raw)
        self._cache[name] = (sig[0], sig[1], options)
        return options

    def names(self):
        """Every wildcard name under the directory, ``/``-separated, sorted."""
        root = self.root()
        out = []
        try:
            walker = os.walk(root)
        except OSError:
            return out
        for dirpath, dirnames, filenames in walker:
            dirnames.sort()
            for filename in sorted(filenames):
                if not filename.lower().endswith(WILDCARD_EXT):
                    continue
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                out.append(rel[: -len(WILDCARD_EXT)])
        return sorted(out)

    def dir_signature(self):
        """sha1 over ``(name, mtime_ns, size)`` for every wildcard file.

        Folded into the node's ``IS_CHANGED`` so editing a wildcard file
        reruns the graph. Content is deliberately *not* hashed: stat is O(1)
        per file and a content change always moves mtime or size.
        """
        root = self.root()
        digest = hashlib.sha1()
        digest.update(b"pl-wildcards-v1")
        for name in self.names():
            path = os.path.join(root, *name.split("/")) + WILDCARD_EXT
            try:
                st = os.stat(path)
                stamp = f"{name}|{st.st_mtime_ns}|{st.st_size}"
            except OSError:
                stamp = f"{name}|missing"
            digest.update(stamp.encode("utf-8", "replace"))
            digest.update(b"\x00")
        return digest.hexdigest()

    def invalidate(self):
        """Drop the mtime cache (tests, and the ``/wildcards`` reload button)."""
        self._cache.clear()
