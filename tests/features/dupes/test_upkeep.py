"""Cached all-pairs scans follow commits: carried, patched, or dropped."""

import pytest

from prompt_librarian.features import dupes
from prompt_librarian.features.prompts import bulk, update, usage
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.features.prompts.delete import delete_prompt

TWIN_A = "make him dance ballet toward the camera"
TWIN_B = "make him dance ballet towards the camera"


@pytest.fixture
def source(lib):
    dupes.invalidate()
    src = dupes.LibraryDupeSource(lib)
    lib.events.subscribe(dupes.patcher(src))
    yield src
    dupes.invalidate()


def _scan(source):
    return dupes.dupe_counts(source, 0.9)


def _cached(lib):
    return dupes.cached_all_settings(lib.revision())


def test_a_body_neutral_write_carries_the_scan(lib, source):
    a, _b = create_prompt(lib, TWIN_A), create_prompt(lib, TWIN_B)
    before = _scan(source)
    usage.record_usage(lib, a["id"])
    update.rate_prompt(lib, a["id"], 5)
    assert _cached(lib) == [(0.9, False)]
    assert _scan(source)["pairs"] == before["pairs"]


@pytest.mark.parametrize("edit", ["create", "update", "delete", "merge"])
def test_a_body_change_is_patched_to_the_same_answer_as_a_rescan(lib, source, edit):
    a, b = create_prompt(lib, TWIN_A), create_prompt(lib, TWIN_B)
    _scan(source)
    if edit == "create":
        create_prompt(lib, "make him dance ballet toward a camera")
    elif edit == "update":
        update.update_prompt(lib, b["id"], body="a quiet harbour at dawn")
    elif edit == "delete":
        delete_prompt(lib, b["id"])
    else:
        bulk.bulk_merge(lib, [a["id"], b["id"]])
    patched = _scan(source)
    assert _cached(lib) == [(0.9, False)]
    dupes.invalidate()
    assert patched["pairs"] == _scan(source)["pairs"]


def test_a_large_write_drops_the_scan(lib, source):
    count = dupes.upkeep.PATCH_LIMIT + 1
    ids = [create_prompt(lib, f"body number {i}")["id"] for i in range(count)]
    _scan(source)
    bulk.bulk_delete(lib, ids)
    assert _cached(lib) == []
