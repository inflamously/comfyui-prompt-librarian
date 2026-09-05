"""Record validation, tolerant loading, version caps and merge arithmetic."""

import pytest

from prompt_librarian.shared import records
from prompt_librarian.shared.errors import BodyTooLargeError


def test_clean_tags_cleans_dedupes_and_caps():
    assert records.clean_tags(["Warm Light", "warm light", " ", "ß"]) == ["warm-light", "ss"]
    assert records.clean_tags("a, b\nc") == ["a", "b", "c"]
    assert records.clean_tags(None) == []
    assert len(records.clean_tags([f"t{i}" for i in range(50)])) == records.MAX_TAGS


def test_clean_body_rejects_instead_of_truncating():
    with pytest.raises(BodyTooLargeError):
        records.clean_body("x" * (records.MAX_BODY_CHARS + 1))


def test_clean_record_keeps_unknown_keys_and_drops_removed_ones():
    rec = records.clean_record({"body": "b", "future": 1, "category": "old", "rating": 9})
    assert rec["future"] == 1
    assert "category" not in rec
    assert rec["rating"] == 5
    assert rec["id"] and rec["created"] and rec["updated"] == rec["created"]


def test_coerce_record_tolerates_oversized_bodies_and_legacy_keys():
    rec = records.coerce_record({"id": "a", "body": "x" * (records.MAX_BODY_CHARS + 1), "_seq": 3})
    assert len(rec["body"]) == records.MAX_BODY_CHARS + 1
    assert "_seq" not in rec
    assert records.coerce_record("not a record") is None


def test_trim_versions_caps_count_then_bytes_but_keeps_one():
    rec = {"versions": [{"body": str(i)} for i in range(10)]}
    records.trim_versions(rec, cap=3)
    assert [v["body"] for v in rec["versions"]] == ["7", "8", "9"]

    rec = {"versions": [{"body": "x" * 10}, {"body": "y" * 10}]}
    records.trim_versions(rec, bytes_cap=5)
    assert [v["body"] for v in rec["versions"]] == ["y" * 10]


def test_merge_fields():
    winner = {"used": 2, "tags": ["a"], "rating": 1, "created": "2026-02", "last_run": "",
              "pinned": False, "notes": "mine"}
    loser = {"used": 3, "tags": ["a", "b"], "rating": 4, "created": "2026-01",
             "last_run": "2026-03", "pinned": True, "notes": "theirs"}
    records.merge_fields(winner, loser)
    assert winner == {"used": 5, "tags": ["a", "b"], "rating": 4, "created": "2026-01",
                      "last_run": "2026-03", "pinned": True, "notes": "mine\n---\ntheirs"}


def test_index_entry_is_the_listing_summary():
    entry = records.index_entry({"body": "a  b", "versions": [{}], "tags": ["t"]})
    assert entry["chars"] == 4
    assert entry["versions"] == 1
    assert entry["preview"] == "a b"
