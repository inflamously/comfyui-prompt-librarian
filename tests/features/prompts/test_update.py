"""Editing: version snapshots, caps, and the concurrency check."""

import pytest

from prompt_librarian.features.library.settings import update_settings
from prompt_librarian.features.prompts import update, versions
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.shared.errors import BodyTooLargeError, ConflictError
from prompt_librarian.shared.records import MAX_BODY_CHARS


def test_a_body_edit_snapshots_the_previous_body(lib):
    rec = create_prompt(lib, "v1")
    edited = update.update_prompt(lib, rec["id"], body="v2")
    assert edited["versions"] == [{"body": "v1", "ts": rec["updated"], "src": None}]


def test_tag_and_rating_edits_do_not_snapshot(lib):
    rec = create_prompt(lib, "v1")
    update.update_prompt(lib, rec["id"], tags=["x"], rating=3)
    assert versions.list_versions(lib, rec["id"]) == []


def test_the_stored_version_cap_drops_the_oldest(lib):
    update_settings(lib, version_cap=2)
    pid = create_prompt(lib, "v0")["id"]
    for index in range(1, 5):
        update.update_prompt(lib, pid, body=f"v{index}")
    assert [v["body"] for v in versions.list_versions(lib, pid)] == ["v2", "v3"]


def test_expect_updated_must_match_the_stored_stamp(lib):
    rec = create_prompt(lib, "v1")
    update.update_prompt(lib, rec["id"], body="v2", expect_updated=rec["updated"])
    with pytest.raises(ConflictError):
        update.update_prompt(lib, rec["id"], body="v3", expect_updated="stale")


def test_an_oversized_body_is_rejected_whole(lib):
    rec = create_prompt(lib, "v1")
    with pytest.raises(BodyTooLargeError):
        update.update_prompt(lib, rec["id"], body="x" * (MAX_BODY_CHARS + 1), rating=5)
    assert update.update_prompt(lib, rec["id"], )["rating"] == 0


def test_restore_makes_a_version_current_and_keeps_the_current_one(lib):
    pid = create_prompt(lib, "v1")["id"]
    update.update_prompt(lib, pid, body="v2")
    restored = versions.restore_version(lib, pid, 0)
    assert restored["body"] == "v1"
    assert [v["body"] for v in restored["versions"]] == ["v1", "v2"]
