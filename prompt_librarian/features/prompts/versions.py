"""A record's version history: listing, reading one, restoring one."""

from collections.abc import Callable

from ...shared.errors import NotFoundError
from ...shared.library import Library
from ...shared.records import Record
from ...shared.text import preview_of
from .get import get_prompt
from .update import update_prompt


def list_versions(lib: Library, pid: str) -> list[dict[str, object]]:
    """Full version entries, oldest first.

    Raises:
        NotFoundError: Unknown id.
    """
    rec = get_prompt(lib, pid)
    if rec is None:
        raise NotFoundError(f"no prompt with id {pid!r}")
    return rec.get("versions", [])


def version_previews(
    lib: Library, pid: str, chars: int = 160, label_fn: Callable[[str], str] | None = None
) -> list[dict[str, object]]:
    """Versions without their full bodies, to keep selection responses small.

    ``label_fn(body)`` is injected so labels stay independent of storage.
    """
    return [
        {
            "index": index,
            "label": str(label_fn(entry.get("body", ""))) if label_fn is not None else "",
            "ts": entry.get("ts", ""),
            "src": entry.get("src"),
            "chars": len(entry.get("body", "")),
            "preview": preview_of(entry.get("body", ""), chars),
        }
        for index, entry in enumerate(list_versions(lib, pid))
    ]


def get_version(lib: Library, pid: str, index: object) -> dict[str, object]:
    """One version entry by index.

    Raises:
        NotFoundError: Unknown id, or an index out of range or not a number.
    """
    entries = list_versions(lib, pid)
    try:
        position = int(index)
    except (TypeError, ValueError) as exc:
        raise NotFoundError(f"bad version index {index!r}") from exc
    if not 0 <= position < len(entries):
        raise NotFoundError(f"no version {position} on prompt {pid}")
    return entries[position]


def restore_version(lib: Library, pid: str, index: object) -> Record:
    """Make a version current again; the current body is snapshotted first."""
    entry = get_version(lib, pid, index)
    return update_prompt(lib, pid, body=entry.get("body", ""))
