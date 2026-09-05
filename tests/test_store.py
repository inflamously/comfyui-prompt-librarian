"""Behavior tests for the authoritative SQLite library store.

Every store points at a synthetic pytest ``tmp_path``.
"""

import json
import os
import sqlite3

import pytest

from tests import uc


def read_raw(store):
    return uc.export_library(store.lib)


def envelope(records, schema=1):
    return {
        "schema": schema,
        "updated": "2026-01-01T00:00:00Z",
        "settings": {"dupe_threshold": 0.9, "version_cap": 50},
        "snippets": {},
        "ignored": [],
        "prompts": records,
    }


def record(pid, **kw):
    base = {
        "id": pid,
        "body": "body of " + pid,
        "tags": [],
        "rating": 0,
        "used": 0,
        "last_run": "",
        "created": "2026-01-01T00:00:00Z",
        "updated": "2026-01-01T00:00:00Z",
        "notes": "",
        "pinned": False,
        "versions": [],
    }
    base.update(kw)
    return base


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #


def test_body_over_the_cap_is_rejected_and_nothing_is_written(store, mod):
    rec = uc.create_prompt(store.lib, body="short")
    huge = "x" * (mod.MAX_BODY_CHARS + 1)

    with pytest.raises(mod.BodyTooLargeError):
        uc.create_prompt(store.lib, body=huge)
    assert uc.count_prompts(store.lib) == 1

    with pytest.raises(mod.BodyTooLargeError):
        uc.update_prompt(store.lib, rec["id"], tags=["kept-out"], body=huge)
    after = uc.get_prompt(store.lib, rec["id"])
    assert after["body"] == "short"
    assert after["tags"] == []  # the tag edit did not sneak through
    assert after["versions"] == []
    assert len(read_raw(store)["prompts"]) == 1

    at_the_limit = "y" * mod.MAX_BODY_CHARS
    assert len(uc.create_prompt(store.lib, body=at_the_limit)["body"]) == mod.MAX_BODY_CHARS


def test_tag_normalization_and_the_tag_cap(store, mod):
    rec = uc.create_prompt(store.lib,
        body="t",
        tags=[
            "  Camera Move  ",
            "camera move",
            "CAMERA\tMOVE",
            "Straße",
            "x" * 60,
            "",
            "   ",
            12,
        ],
    )
    assert rec["tags"] == ["camera-move", "strasse", "x" * mod.MAX_TAG_CHARS, "12"]

    many = uc.create_prompt(store.lib, body="m", tags=[f"tag{i:02d}" for i in range(40)])
    assert len(many["tags"]) == mod.MAX_TAGS
    assert many["tags"][0] == "tag00"
    assert many["tags"][-1] == "tag31"


def test_rating_normalization(store):
    assert uc.create_prompt(store.lib, body="b", rating=42)["rating"] == 5
    assert uc.create_prompt(store.lib, body="b", rating=-3)["rating"] == 0
    assert uc.create_prompt(store.lib, body="b", rating="4")["rating"] == 4


def test_a_record_never_grows_a_name(store, mod):
    """The field is gone: not accepted, not stored, not written."""
    rec = uc.create_prompt(store.lib, body="a body")
    assert "name" not in rec
    assert not hasattr(mod, "clean_name")
    with pytest.raises(TypeError):
        uc.create_prompt(store.lib, body="b", name="nope")
    with pytest.raises(TypeError):
        uc.update_prompt(store.lib, rec["id"], name="nope")
    assert "name" not in read_raw(store)["prompts"][0]


def test_unicode_round_trip_is_written_unescaped(store, fresh):
    body = "cinematic 🎬 ballet, 東京の夜, שלום עולם, café"
    rec = uc.create_prompt(store.lib, body=body, tags=["東京", "🎬"])
    with sqlite3.connect(store.lib.path) as connection:
        stored = connection.execute(
            "SELECT record_json FROM entries WHERE id=?", (rec["id"],)
        ).fetchone()[0]
    assert "🎬" in stored and "東京" in stored and "שלום" in stored
    reloaded = uc.get_prompt(fresh().lib, rec["id"])
    assert reloaded["body"] == body
    assert reloaded["tags"] == ["東京", "🎬"]


# --------------------------------------------------------------------------- #
# versions
# --------------------------------------------------------------------------- #


def test_snapshot_on_body_change_but_not_on_tag_only_change(store):
    rec = uc.create_prompt(store.lib, body="first")
    created_updated = rec["updated"]

    uc.update_prompt(store.lib, rec["id"], tags=["a"], rating=5, notes="n", pinned=True)
    assert uc.list_versions(store.lib, rec["id"]) == []  # metadata edits never snapshot

    after = uc.update_prompt(store.lib, rec["id"], body="second")
    versions = uc.list_versions(store.lib, rec["id"])
    assert len(versions) == 1
    assert versions[0]["body"] == "first"
    assert "name" not in versions[0]
    assert versions[0]["src"] is None
    assert after["body"] == "second"

    uc.update_prompt(store.lib, rec["id"], body="third")
    assert len(uc.list_versions(store.lib, rec["id"])) == 2
    assert uc.list_versions(store.lib, rec["id"])[-1]["body"] == "second"

    # The snapshot carries the PRE-edit updated stamp, not "now".
    assert uc.list_versions(store.lib, rec["id"])[0]["ts"] == created_updated


def test_no_snapshot_when_nothing_actually_changed(store):
    rec = uc.create_prompt(store.lib, body="first", tags=["a"])
    same = uc.update_prompt(store.lib, rec["id"], body="first", tags=["A"])
    assert uc.list_versions(store.lib, rec["id"]) == []
    assert same["updated"] == rec["updated"]


def test_snapshot_false_bypasses_history(store):
    rec = uc.create_prompt(store.lib, body="first")
    uc.update_prompt(store.lib, rec["id"], body="second", snapshot=False)
    assert uc.list_versions(store.lib, rec["id"]) == []
    assert uc.get_prompt(store.lib, rec["id"])["body"] == "second"


def test_version_cap_by_count(store, mod):
    rec = uc.create_prompt(store.lib, body="body-000")
    for i in range(1, mod.VERSION_CAP + 6):
        uc.update_prompt(store.lib, rec["id"], body=f"body-{i:03d}")
    versions = uc.list_versions(store.lib, rec["id"])
    assert len(versions) == mod.VERSION_CAP
    assert versions[0]["body"] == "body-005"  # the oldest were dropped
    assert versions[-1]["body"] == f"body-{mod.VERSION_CAP + 4:03d}"


def test_version_cap_by_bytes(store, mod):
    chunk = 40000
    rec = uc.create_prompt(store.lib, body="0" * chunk)
    for i in range(1, 11):
        uc.update_prompt(store.lib, rec["id"], body=str(i) * chunk)
    versions = uc.list_versions(store.lib, rec["id"])
    total = sum(len(v["body"].encode("utf-8")) for v in versions)
    assert len(versions) < 10  # count cap alone would keep all 10
    assert total <= mod.VERSION_BYTES_CAP
    assert versions[-1]["body"].startswith("9")  # newest kept, oldest dropped


def test_version_previews_and_single_version_fetch(store, mod):
    rec = uc.create_prompt(store.lib, body="first line\nsecond line")
    uc.update_prompt(store.lib, rec["id"], body="replacement")
    previews = uc.version_previews(store.lib, rec["id"], chars=12)
    assert previews == [
        {
            "index": 0,
            "label": "",
            "ts": rec["updated"],
            "src": None,
            "chars": len("first line\nsecond line"),
            "preview": "first line s",
        }
    ]
    # The label is injected, because it is a fact about the whole library and
    # the store is the one layer that must not know about the whole library.
    labelled = uc.version_previews(store.lib, rec["id"], chars=12, label_fn=lambda b: b[:5])
    assert labelled[0]["label"] == "first"
    assert uc.get_version(store.lib, rec["id"], 0)["body"] == "first line\nsecond line"
    with pytest.raises(mod.NotFoundError):
        uc.get_version(store.lib, rec["id"], 7)
    with pytest.raises(mod.NotFoundError):
        uc.list_versions(store.lib, "nope")


def test_restore_version_snapshots_the_current_body_first(store):
    rec = uc.create_prompt(store.lib, body="first")
    uc.update_prompt(store.lib, rec["id"], body="second")
    restored = uc.restore_version(store.lib, rec["id"], 0)

    assert restored["body"] == "first"
    versions = uc.list_versions(store.lib, rec["id"])
    assert [v["body"] for v in versions] == ["first", "second"]
    # ...so the restore is itself undoable: history was extended, never erased.
    again = uc.restore_version(store.lib, rec["id"], 1)
    assert again["body"] == "second"
    assert len(uc.list_versions(store.lib, rec["id"])) == 3


# --------------------------------------------------------------------------- #
# usage
# --------------------------------------------------------------------------- #


def test_record_usage_happy_path(store):
    rec = uc.create_prompt(store.lib, body="  the body  ")
    used = uc.record_usage(store.lib, rec["id"], body="the body")  # whitespace-insensitive
    assert used["used"] == 1
    assert used["last_run"]
    assert used["updated"] == rec["updated"]  # a run is not an edit
    assert uc.record_usage(store.lib, rec["id"])["used"] == 2  # body optional


def test_record_usage_writes_nothing_for_unknown_id_or_edited_body(store):
    rec = uc.create_prompt(store.lib, body="the body")
    before = read_raw(store)
    mtime = os.stat(store.lib.path).st_mtime_ns

    assert uc.record_usage(store.lib, "no-such-id", body="the body") is None
    assert uc.record_usage(store.lib, rec["id"], body="the body, edited") is None

    assert read_raw(store) == before
    assert os.stat(store.lib.path).st_mtime_ns == mtime
    assert uc.get_prompt(store.lib, rec["id"])["used"] == 0


# --------------------------------------------------------------------------- #
# optimistic concurrency
# --------------------------------------------------------------------------- #


def test_expect_updated_guards_the_write(store, mod):
    rec = uc.create_prompt(store.lib, body="one")
    ok = uc.update_prompt(store.lib, rec["id"], body="two", expect_updated=rec["updated"])
    assert ok["body"] == "two"

    with pytest.raises(mod.ConflictError):
        uc.update_prompt(store.lib, rec["id"], body="three", expect_updated="2000-01-01T00:00:00Z")
    assert uc.get_prompt(store.lib, rec["id"])["body"] == "two"


def test_update_and_delete_of_a_missing_record(store, mod):
    with pytest.raises(mod.NotFoundError):
        uc.update_prompt(store.lib, "nope", body="x")
    with pytest.raises(mod.NotFoundError):
        uc.delete_prompt(store.lib, "nope")
    assert uc.get_prompt(store.lib, "nope") is None


# --------------------------------------------------------------------------- #
# merge
# --------------------------------------------------------------------------- #


def build_merge_pair(store):
    uc.import_library(store.lib,
        envelope(
            [
                record(
                    "W",
                    body="winner body",
                    tags=["dance", "shared"],
                    rating=3,
                    used=10,
                    created="2026-01-02T00:00:00Z",
                    updated="2026-03-01T00:00:00Z",
                    last_run="2026-02-01T00:00:00Z",
                    notes="mine",
                    pinned=False,
                    versions=[{"body": "w-old", "ts": "2026-01-05T00:00:00Z", "src": None}],
                ),
                record(
                    "L",
                    body="loser body",
                    tags=["shared", "camera"],
                    rating=5,
                    used=7,
                    created="2026-01-01T00:00:00Z",
                    updated="2026-02-20T00:00:00Z",
                    last_run="2026-02-15T00:00:00Z",
                    notes="theirs",
                    pinned=True,
                    versions=[
                        {"body": f"l-{i}", "ts": f"2026-01-0{i + 1}T00:00:00Z", "src": None}
                        for i in range(7)
                    ],
                ),
            ]
        )
    )


def test_merge_arithmetic(store):
    build_merge_pair(store)
    winner = uc.merge_prompts(store.lib, "W", "L")

    assert winner["used"] == 17  # summed
    assert winner["tags"] == ["dance", "shared", "camera"]  # unioned, order kept
    assert winner["rating"] == 5  # max
    assert winner["created"] == "2026-01-01T00:00:00Z"  # min
    assert winner["last_run"] == "2026-02-15T00:00:00Z"  # max
    assert winner["notes"] == "mine\n---\ntheirs"
    assert winner["pinned"] is True  # OR'd
    assert winner["body"] == "winner body"
    assert winner["updated"] > "2026-03-01T00:00:00Z"

    assert uc.get_prompt(store.lib, "L") is None  # loser deleted
    assert uc.count_prompts(store.lib) == 1

    bodies = [v["body"] for v in winner["versions"]]
    assert bodies[0] == "w-old"  # the winner's own history first
    assert bodies[-1] == "loser body"  # the loser's live body is newest
    assert winner["versions"][-1]["src"] == "L"
    from_loser = [v for v in winner["versions"] if v["src"] == "L"]
    assert len(from_loser) == 6  # 5 kept versions + the body
    assert [v["body"] for v in from_loser[:5]] == ["l-2", "l-3", "l-4", "l-5", "l-6"]


def test_merge_rejects_self_and_missing(store, mod):
    build_merge_pair(store)
    with pytest.raises(mod.SameRecordError):
        uc.merge_prompts(store.lib, "W", "W")
    with pytest.raises(mod.NotFoundError):
        uc.merge_prompts(store.lib, "W", "ghost")
    assert uc.count_prompts(store.lib) == 2


def test_merge_drops_the_ignored_pair(store):
    build_merge_pair(store)
    uc.ignore_pair(store.lib, "W", "L")
    uc.merge_prompts(store.lib, "W", "L")
    assert uc.ignored_pairs(store.lib) == set()


def test_merge_new_absorbs_both_and_deletes_them(store, mod):
    build_merge_pair(store)
    created = uc.merge_into_new(store.lib, "W", "L", body="synthesized body")

    assert created["id"] not in ("W", "L")
    assert uc.get_prompt(store.lib, "W") is None and uc.get_prompt(store.lib, "L") is None
    assert uc.count_prompts(store.lib) == 1
    assert created["body"] == "synthesized body"
    assert created["used"] == 17
    assert created["rating"] == 5
    assert created["tags"] == ["dance", "shared", "camera"]
    assert created["created"] == "2026-01-01T00:00:00Z"
    assert created["last_run"] == "2026-02-15T00:00:00Z"
    assert created["pinned"] is True
    srcs = {v["src"] for v in created["versions"]}
    assert srcs == {"W", "L"}
    assert "winner body" in [v["body"] for v in created["versions"]]
    assert "loser body" in [v["body"] for v in created["versions"]]


def test_merge_new_requires_a_body(store):
    build_merge_pair(store)
    with pytest.raises(ValueError):
        uc.merge_into_new(store.lib, "W", "L", body="")
    with pytest.raises(ValueError):
        uc.merge_into_new(store.lib, "W", "L", body="   ")
    assert uc.count_prompts(store.lib) == 2


def test_bulk_merge_folds_everything_into_the_winner(store):
    a = uc.create_prompt(store.lib, body="a")
    b = uc.create_prompt(store.lib, body="b")
    c = uc.create_prompt(store.lib, body="c")
    uc.record_usage(store.lib, b["id"], body="b")
    uc.record_usage(store.lib, c["id"], body="c")
    winner = uc.bulk_merge(store.lib, [a["id"], b["id"], c["id"]])
    assert winner["id"] == a["id"]
    assert winner["used"] == 2
    assert uc.count_prompts(store.lib) == 1


# --------------------------------------------------------------------------- #
# bulk
# --------------------------------------------------------------------------- #


def test_bulk_delete_and_retag(store):
    a = uc.create_prompt(store.lib, body="a", tags=["keep", "drop"])
    b = uc.create_prompt(store.lib, body="b", tags=["drop"])
    c = uc.create_prompt(store.lib, body="c")

    assert uc.bulk_retag(store.lib, [a["id"], b["id"]], add=["New Tag"], remove=["drop"]) == 2
    assert uc.get_prompt(store.lib, a["id"])["tags"] == ["keep", "new-tag"]
    assert uc.get_prompt(store.lib, b["id"])["tags"] == ["new-tag"]
    assert uc.bulk_retag(store.lib, [c["id"]], replace=["Only"]) == 1
    assert uc.get_prompt(store.lib, c["id"])["tags"] == ["only"]
    assert uc.bulk_retag(store.lib, [c["id"]], replace=["only"]) == 0  # no-op, no write

    assert uc.bulk_delete(store.lib, [a["id"], b["id"], "ghost"]) == 2
    assert uc.count_prompts(store.lib) == 1


# --------------------------------------------------------------------------- #
# taxonomy, snippets, ignored pairs, import/export
# --------------------------------------------------------------------------- #


def test_the_removed_fields_are_scrubbed_on_import(store):
    """`category` / `categories` / `name` are dropped before SQLite writes.

    Unknown keys survive coercion by design, so the scrub has to be explicit —
    which makes this the test that would catch it silently regressing into a
    field that lives on in every file forever.
    """
    uc.import_library(store.lib,
        {
            "schema": 1,
            "categories": ["videogen", "stills"],
            "prompts": [
                {
                    "id": "a" * 32,
                    "name": "hand-typed",
                    "body": "a",
                    "category": "videogen",
                    "tags": ["keep"],
                    "versions": [
                        {
                            "body": "old",
                            "name": "hand-typed-v0",
                            "ts": "2026-01-01T00:00:00Z",
                            "src": None,
                        }
                    ],
                }
            ],
        }
    )
    assert "category" not in uc.all_prompts(store.lib)[0]
    assert "name" not in uc.all_prompts(store.lib)[0]
    assert "name" not in uc.all_prompts(store.lib)[0]["versions"][0]
    assert uc.all_prompts(store.lib)[0]["tags"] == ["keep"]  # the taxonomy that stayed
    assert uc.taxonomy(store.lib) == {"tags": [{"tag": "keep", "count": 1}], "total": 1}

    raw = read_raw(store)
    assert "categories" not in raw
    assert all("category" not in rec for rec in raw["prompts"])
    assert all("name" not in rec for rec in raw["prompts"])
    assert all("name" not in v for rec in raw["prompts"] for v in rec["versions"])


def test_tags_and_taxonomy_counts(store):
    uc.create_prompt(store.lib, body="a", tags=["x", "y"])
    uc.create_prompt(store.lib, body="b", tags=["x"])
    uc.create_prompt(store.lib, body="c")
    assert uc.tag_counts(store.lib) == [{"tag": "x", "count": 2}, {"tag": "y", "count": 1}]
    tax = uc.taxonomy(store.lib)
    assert tax["total"] == 3
    assert "categories" not in tax


def test_snippet_crud(store, mod, fresh):
    uc.set_snippet(store.lib, "  cine_lighting  ", "volumetric haze, 35mm")
    assert uc.get_snippet(store.lib, "cine_lighting") == "volumetric haze, 35mm"
    assert uc.list_snippets(fresh().lib)["cine_lighting"]["updated"]
    uc.set_snippet(store.lib, "cine_lighting", "replaced")
    assert uc.get_snippet(store.lib, "cine_lighting") == "replaced"
    uc.delete_snippet(store.lib, "cine_lighting")
    assert uc.get_snippet(store.lib, "cine_lighting") is None
    assert uc.get_snippet(store.lib, "cine_lighting") is None
    with pytest.raises(mod.NotFoundError):
        uc.delete_snippet(store.lib, "cine_lighting")
    with pytest.raises(ValueError):
        uc.set_snippet(store.lib, "   ", "x")


def test_ignore_pair_is_order_independent(store):
    assert uc.ignore_pair(store.lib, "bbb", "aaa") is True
    assert uc.is_ignored(store.lib, "aaa", "bbb") is True
    assert uc.is_ignored(store.lib, "bbb", "aaa") is True
    assert uc.ignored_pairs(store.lib) == {("aaa", "bbb")}
    assert uc.ignore_pair(store.lib, "aaa", "bbb") is False  # already recorded
    assert read_raw(store)["ignored"] == [["aaa", "bbb"]]  # stored sorted
    assert uc.unignore_pair(store.lib, "bbb", "aaa") is True
    assert uc.is_ignored(store.lib, "aaa", "bbb") is False


def test_deleting_a_record_forgets_its_ignored_pairs(store):
    a = uc.create_prompt(store.lib, body="a")
    b = uc.create_prompt(store.lib, body="b")
    uc.ignore_pair(store.lib, a["id"], b["id"])
    uc.delete_prompt(store.lib, a["id"])
    assert uc.ignored_pairs(store.lib) == set()


def test_export_and_import_raw(store, mod):
    a = uc.create_prompt(store.lib, body="a", tags=["t"])
    uc.set_snippet(store.lib, "s", "snippet body")
    dump = uc.export_library(store.lib)
    assert json.dumps(dump)  # must be json-serializable as-is

    uc.delete_prompt(store.lib, a["id"])
    assert uc.count_prompts(store.lib) == 0
    assert uc.import_library(store.lib, dump) == 1
    assert uc.get_prompt(store.lib, a["id"])["tags"] == ["t"]

    # append mode never clobbers a resident record
    assert uc.import_library(store.lib, dump, replace=False) == 1
    assert uc.count_prompts(store.lib) == 2
    assert len({r["id"] for r in uc.all_prompts(store.lib)}) == 2
    assert uc.import_library(store.lib, "total garbage") == 0


def test_settings_round_trip(store, fresh):
    assert uc.read_settings(store.lib)["dupe_threshold"] == 0.90
    updated = uc.update_settings(store.lib, dupe_threshold=2.5, version_cap=3)
    assert updated["dupe_threshold"] == 1.0  # clamped
    assert updated["version_cap"] == 3
    assert uc.read_settings(fresh().lib)["version_cap"] == 3


def test_version_cap_setting_is_honoured(store):
    uc.update_settings(store.lib, version_cap=2)
    rec = uc.create_prompt(store.lib, body="b0")
    for i in range(1, 6):
        uc.update_prompt(store.lib, rec["id"], body=f"b{i}")
    assert [v["body"] for v in uc.list_versions(store.lib, rec["id"])] == ["b3", "b4"]


# --------------------------------------------------------------------------- #
# listeners
# --------------------------------------------------------------------------- #


def test_changes_report_ids_and_records(store):
    events = []
    off = store.lib.events.subscribe(events.append)

    rec = uc.create_prompt(store.lib, body="a")
    assert events[-1].op == "create"
    assert events[-1].ids == (rec["id"],)
    assert events[-1].records[rec["id"]]["body"] == "a"

    uc.update_prompt(store.lib, rec["id"], body="b")
    assert events[-1].op == "update"

    uc.delete_prompt(store.lib, rec["id"])
    assert events[-1].op == "delete"
    assert events[-1].records == {rec["id"]: None}  # None means deleted

    off()
    uc.create_prompt(store.lib, body="c")
    assert events[-1].op == "delete"  # unsubscribed


def test_a_broken_listener_cannot_fail_a_write(store):
    def boom(_change):
        raise RuntimeError("listener bug")

    store.lib.events.subscribe(boom)
    rec = uc.create_prompt(store.lib, body="a")
    assert uc.get_prompt(store.lib, rec["id"]) is not None


def test_concurrent_writers_do_not_lose_records(store):
    import threading

    errors = []

    def worker(index):
        try:
            for i in range(5):
                uc.create_prompt(store.lib, body=f"body {index} {i}")
        except Exception as exc:  # pragma: no cover - only fires on a real bug
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert uc.count_prompts(store.lib) == 20
    assert len(read_raw(store)["prompts"]) == 20


def test_returned_records_are_copies(store):
    rec = uc.create_prompt(store.lib, body="a", tags=["t"])
    rec["tags"].append("mutated")
    rec["body"] = "mutated"
    assert uc.get_prompt(store.lib, rec["id"])["tags"] == ["t"]
    assert uc.get_prompt(store.lib, rec["id"])["body"] == "a"
