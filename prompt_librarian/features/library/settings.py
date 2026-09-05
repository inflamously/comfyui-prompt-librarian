"""Reading and changing the library settings."""

from typing import Any

from ...shared import meta
from ...shared.coerce import as_int, clamp
from ...shared.errors import StoreWriteError
from ...shared.library import Library
from ...shared.records import VERSION_CAP


def read_settings(lib: Library) -> dict[str, Any]:
    """The settings block; defaults when the library cannot be read."""
    try:
        return dict(meta.load(lib)["settings"])
    except StoreWriteError:
        return meta.clean_settings({})


def version_cap(lib: Library) -> int:
    """How many versions a record keeps."""
    cap = read_settings(lib).get("version_cap", VERSION_CAP)
    return clamp(as_int(cap, VERSION_CAP), 1, 1000)


def update_settings(
    lib: Library, dupe_threshold: object = None, version_cap: object = None
) -> dict[str, Any]:
    """Change only the settings given; returns the new settings block.

    Raises:
        ValueError: ``dupe_threshold`` is not a number.
    """
    changes: dict[str, Any] = {}
    if dupe_threshold is not None:
        try:
            changes["dupe_threshold"] = clamp(float(dupe_threshold), 0.0, 1.0)
        except (TypeError, ValueError) as exc:
            raise ValueError("dupe_threshold must be a number in 0..1") from exc
    if version_cap is not None:
        changes["version_cap"] = clamp(as_int(version_cap, VERSION_CAP), 1, 1000)
    with meta.edit(lib, "settings") as (_work, stored):
        stored["settings"] = meta.clean_settings({**stored["settings"], **changes})
    return dict(stored["settings"])
