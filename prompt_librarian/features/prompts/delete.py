"""Deleting a record outright; there is no trash bin."""

from ...shared import entries
from ...shared.errors import NotFoundError
from ...shared.library import Library


def delete_prompt(lib: Library, pid: str) -> None:
    """Delete one record.

    Raises:
        NotFoundError: Unknown id; nothing is written.
    """
    with lib.write("delete") as work:
        if not entries.remove(work, pid):
            raise NotFoundError(f"no prompt with id {pid!r}")
