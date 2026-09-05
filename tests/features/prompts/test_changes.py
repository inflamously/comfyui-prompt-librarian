"""Every write commits once and reports exactly what it did."""

import pytest

from prompt_librarian.features.prompts import bulk, get, merge, update, usage
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.features.prompts.delete import delete_prompt
from prompt_librarian.shared.errors import ConflictError, NotFoundError


def _last(changes):
    change = changes[-1]
    return change.op, change.ids, change.new_rev - change.old_rev, change.bodies_changed


def test_create_reports_one_new_revision(lib, changes):
    rec = create_prompt(lib, "a body")
    assert _last(changes) == ("create", (rec["id"],), 1, True)
    assert changes[-1].records[rec["id"]]["body"] == "a body"
    assert lib.revision() == changes[-1].new_rev


@pytest.mark.parametrize(
    ("edit", "bodies_changed"),
    [
        (lambda lib, pid: update.update_prompt(lib, pid, body="new"), True),
        (lambda lib, pid: update.update_prompt(lib, pid, tags=["t"]), False),
        (lambda lib, pid: update.rate_prompt(lib, pid, 4), False),
        (lambda lib, pid: usage.record_usage(lib, pid), False),
        (lambda lib, pid: bulk.bulk_retag(lib, [pid], add=["t"]), False),
    ],
)
def test_bodies_changed_is_true_only_when_a_body_did(lib, changes, edit, bodies_changed):
    pid = create_prompt(lib, "old")["id"]
    edit(lib, pid)
    assert changes[-1].bodies_changed is bodies_changed


def test_a_no_op_write_commits_nothing(lib, changes):
    rec = create_prompt(lib, "same")
    before = (len(changes), lib.revision())
    assert update.update_prompt(lib, rec["id"], body="same") == rec
    assert usage.record_usage(lib, rec["id"], body="an unsaved edit") is None
    assert bulk.bulk_retag(lib, [rec["id"]], remove=["absent"]) == 0
    assert (len(changes), lib.revision()) == before


def test_a_failed_write_rolls_back_and_reports_nothing(lib, changes):
    rec = create_prompt(lib, "mine")
    before = (len(changes), lib.revision())
    with pytest.raises(ConflictError):
        update.update_prompt(lib, rec["id"], body="x", expect_updated="1999-01-01T00:00:00Z")
    with pytest.raises(NotFoundError):
        delete_prompt(lib, "missing")
    assert (len(changes), lib.revision()) == before
    assert get.get_prompt(lib, rec["id"])["body"] == "mine"


def test_merge_is_one_change_naming_winner_and_loser(lib, changes):
    winner = create_prompt(lib, "keep me", tags=["a"])
    loser = create_prompt(lib, "absorb me", tags=["b"])
    merged = merge.merge_prompts(lib, winner["id"], loser["id"])
    assert _last(changes) == ("merge", (winner["id"], loser["id"]), 1, True)
    assert changes[-1].records == {winner["id"]: merged, loser["id"]: None}
    assert merged["tags"] == ["a", "b"]
    absorbed = {"body": "absorb me", "ts": loser["updated"], "src": loser["id"]}
    assert merged["versions"][-1] == absorbed
    assert get.prompt_ids(lib) == [winner["id"]]
