"""Unit tests for ``prompt_librarian.store``.

Everything here runs against a store pointed at a pytest ``tmp_path``; the real
ComfyUI user directory (and the old node's ``prompts.json``) is never touched.
"""

import json
import os

import pytest

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def read_raw(store):
    with open(store.store_path(), encoding="utf-8") as handle:
        return json.load(handle)


def read_text(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def write_raw(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


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
# load / save
# --------------------------------------------------------------------------- #

def test_construction_and_empty_load_touch_no_disk(tmp_path, mod):
    path = tmp_path / "nothing" / "library.json"
    store = mod.LibrarianStore(path=str(path))
    assert store.rev() == 0
    assert not path.parent.exists()
    assert store.count() == 0          # loading a missing file must not create it
    assert store.all() == []
    assert not path.parent.exists()
    assert store.rev() == 1            # the load itself bumped the revision


def test_round_trip_create_save_and_fresh_instance_load(store, fresh):
    rec = store.create(body="drifting toward the camera",
                       tags=["Dance", "camera move"], rating=4,
                       notes="hi", pinned=True)
    assert len(rec["id"]) == 32
    assert rec["tags"] == ["dance", "camera-move"]
    assert rec["created"] == rec["updated"]
    assert rec["versions"] == []

    other = fresh()
    loaded = other.get(rec["id"])
    assert loaded == rec
    assert os.path.isfile(store.store_path())


def test_reload_when_the_file_changes_underneath(store, fresh, lib_path):
    a = store.create(body="one")
    reader = fresh()
    assert reader.get(a["id"])["body"] == "one"
    rev_before = reader.rev()

    # A second process (here: a second store instance) rewrites the file.
    writer = fresh()
    writer.update(a["id"], body="edited-by-someone-else")

    assert reader.get(a["id"])["body"] == "edited-by-someone-else"
    assert reader.rev() > rev_before


def test_reload_before_mutate_keeps_the_other_records(store, fresh, lib_path):
    a = store.create(body="a")
    other = fresh()
    b = other.create(body="b")      # store's in-memory copy is now stale
    store.update(a["id"], body="a2")          # must reload rather than clobber b
    bodies = sorted(r["body"] for r in fresh().all())
    assert bodies == ["a2", "b"]
    assert fresh().get(b["id"]) is not None


def test_save_writes_a_backup_of_the_previous_file(store):
    store.create(body="one")
    store.create(body="two")
    backup = store.backup_path()
    assert os.path.isfile(backup)
    with open(backup, encoding="utf-8") as handle:
        previous = json.load(handle)
    assert len(previous["prompts"]) == 1       # the state before the second save


def test_atomic_write_retries_permission_error(store, mod, monkeypatch):
    store.create(body="one")
    real_replace = os.replace
    target = os.path.abspath(store.store_path())
    calls = {"n": 0}

    def flaky(src, dst, *args, **kwargs):
        if os.path.abspath(dst) == target:
            calls["n"] += 1
            if calls["n"] <= 2:
                raise PermissionError(13, "locked by a virus scanner")
        return real_replace(src, dst, *args, **kwargs)

    monkeypatch.setattr(os, "replace", flaky)
    monkeypatch.setattr(mod.time, "sleep", lambda *_: None)

    rec = store.create(body="two")
    assert calls["n"] == 3                      # two failures, then success
    monkeypatch.undo()
    assert len(read_raw(store)["prompts"]) == 2
    assert store.get(rec["id"])["body"] == "two"


def test_write_failure_raises_and_leaves_the_file_intact(store, mod, monkeypatch):
    store.create(body="one")
    before = read_raw(store)
    directory = store.store_dir()

    def always_locked(src, dst, *args, **kwargs):
        raise PermissionError(13, "locked forever")

    monkeypatch.setattr(os, "replace", always_locked)
    monkeypatch.setattr(mod.time, "sleep", lambda *_: None)
    with pytest.raises(mod.StoreWriteError):
        store.create(body="two")
    monkeypatch.undo()

    assert read_raw(store) == before
    leftovers = [n for n in os.listdir(directory) if ".tmp-" in n]
    assert leftovers == []                      # the temp file is cleaned up


def test_serialization_failure_never_touches_the_disk(store, mod, monkeypatch):
    store.create(body="one")
    before = read_raw(store)
    def boom(*_a, **_k):
        raise TypeError("nope")

    monkeypatch.setattr(mod.json, "dumps", boom)
    with pytest.raises(mod.StoreWriteError):
        store.create(body="two")
    monkeypatch.undo()
    assert read_raw(store) == before


# --------------------------------------------------------------------------- #
# corruption / forward schema
# --------------------------------------------------------------------------- #

def test_corrupt_file_loads_empty_and_is_preserved_then_quarantined(store, lib_path, mod):
    write_raw(lib_path, '{"prompts": [ this is not json')
    original = read_text(lib_path)

    assert store.count() == 0
    assert store.is_corrupt() is True
    assert read_text(lib_path) == original                       # untouched so far

    store.create(body="rescue")
    assert store.is_corrupt() is False

    quarantined = [n for n in os.listdir(store.store_dir()) if ".corrupt-" in n]
    assert len(quarantined) == 1
    with open(os.path.join(store.store_dir(), quarantined[0]), encoding="utf-8") as handle:
        assert handle.read() == original                             # never overwritten
    assert len(read_raw(store)["prompts"]) == 1


def test_non_dict_root_is_treated_as_corrupt(store, lib_path):
    write_raw(lib_path, [1, 2, 3])
    assert store.count() == 0
    assert store.is_corrupt() is True


def test_hand_edited_file_is_coerced_and_unknown_keys_survive(store, lib_path):
    write_raw(lib_path, {
        "schema": 1,
        "future_top_level": {"keep": "me"},
        "ignored": [["z", "a"], ["a", "z"], "junk"],
        "snippets": {"plain": "a string snippet"},
        "prompts": [
            "not a record",
            {"body": "no id at all", "tags": "Alpha,Beta", "rating": 99,
             "future_field": 7},
        ],
    })
    assert store.count() == 1
    rec = store.all()[0]
    assert len(rec["id"]) == 32
    assert rec["body"] == "no id at all"
    assert rec["tags"] == ["alpha", "beta"]
    assert rec["rating"] == 5
    assert rec["future_field"] == 7
    assert store.ignored_pairs() == {("a", "z")}
    assert store.snippets()["plain"]["body"] == "a string snippet"

    store.create(body="x")
    raw = read_raw(store)
    assert raw["future_top_level"] == {"keep": "me"}
    assert any(r.get("future_field") == 7 for r in raw["prompts"])


def test_duplicate_ids_are_re_keyed_on_load(store, lib_path):
    write_raw(lib_path, envelope([record("dup"), record("dup", body="second")]))
    ids = {r["id"] for r in store.all()}
    assert len(ids) == 2


def test_forward_schema_is_read_only(store, lib_path, mod):
    write_raw(lib_path, envelope([record("a")], schema=99))
    assert store.count() == 1                    # readable
    assert store.is_readonly() is True
    with pytest.raises(mod.ReadOnlyError):
        store.create(body="x")
    with pytest.raises(mod.ReadOnlyError):
        store.update("a", body="x")
    with pytest.raises(mod.ReadOnlyError):
        store.delete("a")
    with pytest.raises(mod.ReadOnlyError):
        store.record_usage("a", body="body of a")
    assert read_raw(store)["schema"] == 99


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #

def test_body_over_the_cap_is_rejected_and_nothing_is_written(store, mod):
    rec = store.create(body="short")
    huge = "x" * (mod.MAX_BODY_CHARS + 1)

    with pytest.raises(mod.BodyTooLargeError):
        store.create(body=huge)
    assert store.count() == 1

    with pytest.raises(mod.BodyTooLargeError):
        store.update(rec["id"], tags=["kept-out"], body=huge)
    after = store.get(rec["id"])
    assert after["body"] == "short"
    assert after["tags"] == []                  # the tag edit did not sneak through
    assert after["versions"] == []
    assert len(read_raw(store)["prompts"]) == 1

    at_the_limit = "y" * mod.MAX_BODY_CHARS
    assert len(store.create(body=at_the_limit)["body"]) == mod.MAX_BODY_CHARS


def test_tag_normalization_and_the_tag_cap(store, mod):
    rec = store.create(body="t", tags=[
        "  Camera Move  ", "camera move", "CAMERA\tMOVE", "Straße",
        "x" * 60, "", "   ", 12,
    ])
    assert rec["tags"] == ["camera-move", "strasse", "x" * mod.MAX_TAG_CHARS, "12"]

    many = store.create(body="m", tags=[f"tag{i:02d}" for i in range(40)])
    assert len(many["tags"]) == mod.MAX_TAGS
    assert many["tags"][0] == "tag00"
    assert many["tags"][-1] == "tag31"


def test_rating_normalization(store):
    assert store.create(body="b", rating=42)["rating"] == 5
    assert store.create(body="b", rating=-3)["rating"] == 0
    assert store.create(body="b", rating="4")["rating"] == 4


def test_a_record_never_grows_a_name(store, mod):
    """The field is gone: not accepted, not stored, not written."""
    rec = store.create(body="a body")
    assert "name" not in rec
    assert not hasattr(mod, "clean_name")
    with pytest.raises(TypeError):
        store.create(body="b", name="nope")
    with pytest.raises(TypeError):
        store.update(rec["id"], name="nope")
    assert "name" not in read_raw(store)["prompts"][0]


def test_unicode_round_trip_is_written_unescaped(store, fresh):
    body = "cinematic 🎬 ballet, 東京の夜, שלום עולם, café"
    rec = store.create(body=body, tags=["東京", "🎬"])
    with open(store.store_path(), encoding="utf-8") as handle:
        text = handle.read()
    assert "🎬" in text and "東京" in text and "שלום" in text     # ensure_ascii=False
    reloaded = fresh().get(rec["id"])
    assert reloaded["body"] == body
    assert reloaded["tags"] == ["東京", "🎬"]


# --------------------------------------------------------------------------- #
# versions
# --------------------------------------------------------------------------- #

def test_snapshot_on_body_change_but_not_on_tag_only_change(store):
    rec = store.create(body="first")
    created_updated = rec["updated"]

    store.update(rec["id"], tags=["a"], rating=5, notes="n", pinned=True)
    assert store.versions(rec["id"]) == []       # metadata edits never snapshot

    after = store.update(rec["id"], body="second")
    versions = store.versions(rec["id"])
    assert len(versions) == 1
    assert versions[0]["body"] == "first"
    assert "name" not in versions[0]
    assert versions[0]["src"] is None
    assert after["body"] == "second"

    store.update(rec["id"], body="third")
    assert len(store.versions(rec["id"])) == 2
    assert store.versions(rec["id"])[-1]["body"] == "second"

    # The snapshot carries the PRE-edit updated stamp, not "now".
    assert store.versions(rec["id"])[0]["ts"] == created_updated


def test_no_snapshot_when_nothing_actually_changed(store):
    rec = store.create(body="first", tags=["a"])
    same = store.update(rec["id"], body="first", tags=["A"])
    assert store.versions(rec["id"]) == []
    assert same["updated"] == rec["updated"]


def test_snapshot_false_bypasses_history(store):
    rec = store.create(body="first")
    store.update(rec["id"], body="second", snapshot=False)
    assert store.versions(rec["id"]) == []
    assert store.get(rec["id"])["body"] == "second"


def test_version_cap_by_count(store, mod):
    rec = store.create(body="body-000")
    for i in range(1, mod.VERSION_CAP + 6):
        store.update(rec["id"], body=f"body-{i:03d}")
    versions = store.versions(rec["id"])
    assert len(versions) == mod.VERSION_CAP
    assert versions[0]["body"] == "body-005"     # the oldest were dropped
    assert versions[-1]["body"] == f"body-{mod.VERSION_CAP + 4:03d}"


def test_version_cap_by_bytes(store, mod):
    chunk = 40000
    rec = store.create(body="0" * chunk)
    for i in range(1, 11):
        store.update(rec["id"], body=str(i) * chunk)
    versions = store.versions(rec["id"])
    total = sum(len(v["body"].encode("utf-8")) for v in versions)
    assert len(versions) < 10                    # count cap alone would keep all 10
    assert total <= mod.VERSION_BYTES_CAP
    assert versions[-1]["body"].startswith("9")  # newest kept, oldest dropped


def test_version_previews_and_single_version_fetch(store, mod):
    rec = store.create(body="first line\nsecond line")
    store.update(rec["id"], body="replacement")
    previews = store.version_previews(rec["id"], chars=12)
    assert previews == [{
        "index": 0, "label": "", "ts": rec["updated"], "src": None,
        "chars": len("first line\nsecond line"), "preview": "first line s",
    }]
    # The label is injected, because it is a fact about the whole library and
    # the store is the one layer that must not know about the whole library.
    labelled = store.version_previews(rec["id"], chars=12, label_fn=lambda b: b[:5])
    assert labelled[0]["label"] == "first"
    assert store.version(rec["id"], 0)["body"] == "first line\nsecond line"
    with pytest.raises(mod.NotFoundError):
        store.version(rec["id"], 7)
    with pytest.raises(mod.NotFoundError):
        store.versions("nope")


def test_restore_version_snapshots_the_current_body_first(store):
    rec = store.create(body="first")
    store.update(rec["id"], body="second")
    restored = store.restore_version(rec["id"], 0)

    assert restored["body"] == "first"
    versions = store.versions(rec["id"])
    assert [v["body"] for v in versions] == ["first", "second"]
    # ...so the restore is itself undoable: history was extended, never erased.
    again = store.restore_version(rec["id"], 1)
    assert again["body"] == "second"
    assert len(store.versions(rec["id"])) == 3


# --------------------------------------------------------------------------- #
# usage
# --------------------------------------------------------------------------- #

def test_record_usage_happy_path(store):
    rec = store.create(body="  the body  ")
    used = store.record_usage(rec["id"], body="the body")   # whitespace-insensitive
    assert used["used"] == 1
    assert used["last_run"]
    assert used["updated"] == rec["updated"]                # a run is not an edit
    assert store.record_usage(rec["id"])["used"] == 2       # body optional


def test_record_usage_writes_nothing_for_unknown_id_or_edited_body(store):
    rec = store.create(body="the body")
    before = read_raw(store)
    mtime = os.stat(store.store_path()).st_mtime_ns

    assert store.record_usage("no-such-id", body="the body") is None
    assert store.record_usage(rec["id"], body="the body, edited") is None

    assert read_raw(store) == before
    assert os.stat(store.store_path()).st_mtime_ns == mtime
    assert store.get(rec["id"])["used"] == 0


# --------------------------------------------------------------------------- #
# optimistic concurrency
# --------------------------------------------------------------------------- #

def test_expect_updated_guards_the_write(store, mod):
    rec = store.create(body="one")
    ok = store.update(rec["id"], body="two", expect_updated=rec["updated"])
    assert ok["body"] == "two"

    with pytest.raises(mod.ConflictError):
        store.update(rec["id"], body="three", expect_updated="2000-01-01T00:00:00Z")
    assert store.get(rec["id"])["body"] == "two"


def test_update_and_delete_of_a_missing_record(store, mod):
    with pytest.raises(mod.NotFoundError):
        store.update("nope", body="x")
    with pytest.raises(mod.NotFoundError):
        store.delete("nope")
    assert store.get("nope") is None


# --------------------------------------------------------------------------- #
# merge
# --------------------------------------------------------------------------- #

def build_merge_pair(store):
    store.import_raw(envelope([
        record("W", body="winner body",
               tags=["dance", "shared"], rating=3, used=10,
               created="2026-01-02T00:00:00Z", updated="2026-03-01T00:00:00Z",
               last_run="2026-02-01T00:00:00Z", notes="mine", pinned=False,
               versions=[{"body": "w-old",
                          "ts": "2026-01-05T00:00:00Z", "src": None}]),
        record("L", body="loser body",
               tags=["shared", "camera"], rating=5, used=7,
               created="2026-01-01T00:00:00Z", updated="2026-02-20T00:00:00Z",
               last_run="2026-02-15T00:00:00Z", notes="theirs", pinned=True,
               versions=[{"body": f"l-{i}",
                          "ts": f"2026-01-0{i + 1}T00:00:00Z", "src": None}
                         for i in range(7)]),
    ]))


def test_merge_arithmetic(store):
    build_merge_pair(store)
    winner = store.merge("W", "L")

    assert winner["used"] == 17                      # summed
    assert winner["tags"] == ["dance", "shared", "camera"]   # unioned, order kept
    assert winner["rating"] == 5                     # max
    assert winner["created"] == "2026-01-01T00:00:00Z"       # min
    assert winner["last_run"] == "2026-02-15T00:00:00Z"      # max
    assert winner["notes"] == "mine\n---\ntheirs"
    assert winner["pinned"] is True                  # OR'd
    assert winner["body"] == "winner body"
    assert winner["updated"] > "2026-03-01T00:00:00Z"

    assert store.get("L") is None                    # loser deleted
    assert store.count() == 1

    bodies = [v["body"] for v in winner["versions"]]
    assert bodies[0] == "w-old"                      # the winner's own history first
    assert bodies[-1] == "loser body"                # the loser's live body is newest
    assert winner["versions"][-1]["src"] == "L"
    from_loser = [v for v in winner["versions"] if v["src"] == "L"]
    assert len(from_loser) == 6                      # 5 kept versions + the body
    assert [v["body"] for v in from_loser[:5]] == ["l-2", "l-3", "l-4", "l-5", "l-6"]


def test_merge_rejects_self_and_missing(store, mod):
    build_merge_pair(store)
    with pytest.raises(mod.SameRecordError):
        store.merge("W", "W")
    with pytest.raises(mod.NotFoundError):
        store.merge("W", "ghost")
    assert store.count() == 2


def test_merge_drops_the_ignored_pair(store):
    build_merge_pair(store)
    store.ignore_pair("W", "L")
    store.merge("W", "L")
    assert store.ignored_pairs() == set()


def test_merge_new_absorbs_both_and_deletes_them(store, mod):
    build_merge_pair(store)
    created = store.merge_new("W", "L", body="synthesized body")

    assert created["id"] not in ("W", "L")
    assert store.get("W") is None and store.get("L") is None
    assert store.count() == 1
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
        store.merge_new("W", "L", body="")
    with pytest.raises(ValueError):
        store.merge_new("W", "L", body="   ")
    assert store.count() == 2


def test_bulk_merge_folds_everything_into_the_winner(store):
    a = store.create(body="a")
    b = store.create(body="b")
    c = store.create(body="c")
    store.record_usage(b["id"], body="b")
    store.record_usage(c["id"], body="c")
    winner = store.bulk_merge([a["id"], b["id"], c["id"]])
    assert winner["id"] == a["id"]
    assert winner["used"] == 2
    assert store.count() == 1


# --------------------------------------------------------------------------- #
# bulk
# --------------------------------------------------------------------------- #

def test_bulk_delete_and_retag(store):
    a = store.create(body="a", tags=["keep", "drop"])
    b = store.create(body="b", tags=["drop"])
    c = store.create(body="c")

    assert store.bulk_retag([a["id"], b["id"]], add=["New Tag"], remove=["drop"]) == 2
    assert store.get(a["id"])["tags"] == ["keep", "new-tag"]
    assert store.get(b["id"])["tags"] == ["new-tag"]
    assert store.bulk_retag([c["id"]], replace=["Only"]) == 1
    assert store.get(c["id"])["tags"] == ["only"]
    assert store.bulk_retag([c["id"]], replace=["only"]) == 0      # no-op, no write

    assert store.bulk_delete([a["id"], b["id"], "ghost"]) == 2
    assert store.count() == 1


# --------------------------------------------------------------------------- #
# taxonomy, snippets, ignored pairs, import/export
# --------------------------------------------------------------------------- #

def test_the_removed_fields_are_scrubbed_on_load(store, lib_path):
    """`category` / `categories` / `name` are dropped and written out.

    Unknown keys survive coercion by design, so the scrub has to be explicit —
    which makes this the test that would catch it silently regressing into a
    field that lives on in every file forever.
    """
    write_raw(lib_path, {
        "schema": 1,
        "categories": ["videogen", "stills"],
        "prompts": [{"id": "a" * 32, "name": "hand-typed", "body": "a",
                     "category": "videogen", "tags": ["keep"],
                     "versions": [{"body": "old", "name": "hand-typed-v0",
                                   "ts": "2026-01-01T00:00:00Z", "src": None}]}],
    })
    assert "category" not in store.all()[0]
    assert "name" not in store.all()[0]
    assert "name" not in store.all()[0]["versions"][0]
    assert store.all()[0]["tags"] == ["keep"]           # the taxonomy that stayed
    assert store.taxonomy() == {"tags": [{"tag": "keep", "count": 1}], "total": 1}

    store.create(body="x")                    # any write rewrites the file
    raw = read_raw(store)
    assert "categories" not in raw
    assert all("category" not in rec for rec in raw["prompts"])
    assert all("name" not in rec for rec in raw["prompts"])
    assert all("name" not in v for rec in raw["prompts"] for v in rec["versions"])


def test_tags_and_taxonomy_counts(store):
    store.create(body="a", tags=["x", "y"])
    store.create(body="b", tags=["x"])
    store.create(body="c")
    assert store.tags() == [{"tag": "x", "count": 2}, {"tag": "y", "count": 1}]
    tax = store.taxonomy()
    assert tax["total"] == 3
    assert "categories" not in tax


def test_snippet_crud(store, mod, fresh):
    store.set_snippet("  cine_lighting  ", "volumetric haze, 35mm")
    assert store.get_snippet("cine_lighting") == "volumetric haze, 35mm"
    assert fresh().snippets()["cine_lighting"]["updated"]
    store.set_snippet("cine_lighting", "replaced")
    assert store.get_snippet("cine_lighting") == "replaced"
    assert store.delete_snippet("cine_lighting") is True
    assert store.get_snippet("cine_lighting") is None
    with pytest.raises(mod.NotFoundError):
        store.delete_snippet("cine_lighting")
    with pytest.raises(ValueError):
        store.set_snippet("   ", "x")


def test_ignore_pair_is_order_independent(store):
    assert store.ignore_pair("bbb", "aaa") is True
    assert store.is_ignored("aaa", "bbb") is True
    assert store.is_ignored("bbb", "aaa") is True
    assert store.ignored_pairs() == {("aaa", "bbb")}
    assert store.ignore_pair("aaa", "bbb") is False          # already recorded
    assert read_raw(store)["ignored"] == [["aaa", "bbb"]]    # stored sorted
    assert store.unignore_pair("bbb", "aaa") is True
    assert store.is_ignored("aaa", "bbb") is False


def test_deleting_a_record_forgets_its_ignored_pairs(store):
    a = store.create(body="a")
    b = store.create(body="b")
    store.ignore_pair(a["id"], b["id"])
    store.delete(a["id"])
    assert store.ignored_pairs() == set()


def test_export_and_import_raw(store, mod):
    a = store.create(body="a", tags=["t"])
    store.set_snippet("s", "snippet body")
    dump = store.export_raw()
    assert json.dumps(dump)                     # must be json-serializable as-is

    store.delete(a["id"])
    assert store.count() == 0
    assert store.import_raw(dump) == 1
    assert store.get(a["id"])["tags"] == ["t"]

    # append mode never clobbers a resident record
    assert store.import_raw(dump, replace=False) == 1
    assert store.count() == 2
    assert len({r["id"] for r in store.all()}) == 2
    assert store.import_raw("total garbage") == 0


def test_settings_round_trip(store, fresh):
    assert store.settings()["dupe_threshold"] == 0.90
    updated = store.set_settings(dupe_threshold=2.5, version_cap=3)
    assert updated["dupe_threshold"] == 1.0     # clamped
    assert updated["version_cap"] == 3
    assert fresh().settings()["version_cap"] == 3


def test_version_cap_setting_is_honoured(store):
    store.set_settings(version_cap=2)
    rec = store.create(body="b0")
    for i in range(1, 6):
        store.update(rec["id"], body=f"b{i}")
    assert [v["body"] for v in store.versions(rec["id"])] == ["b3", "b4"]


# --------------------------------------------------------------------------- #
# listeners
# --------------------------------------------------------------------------- #

def test_on_change_reports_ids_and_records(store):
    events = []
    off = store.on_change(lambda op, ids, records: events.append((op, ids, records)))

    rec = store.create(body="a")
    assert events[-1][0] == "create"
    assert events[-1][1] == [rec["id"]]
    assert events[-1][2][rec["id"]]["body"] == "a"

    store.update(rec["id"], body="b")
    assert events[-1][0] == "update"

    store.delete(rec["id"])
    assert events[-1][0] == "delete"
    assert events[-1][2] == {rec["id"]: None}      # None means deleted

    off()
    store.create(body="c")
    assert events[-1][0] == "delete"               # unsubscribed


def test_a_broken_listener_cannot_fail_a_write(store):
    def boom(op, ids, records):
        raise RuntimeError("listener bug")

    store.on_change(boom)
    rec = store.create(body="a")
    assert store.get(rec["id"]) is not None


def test_concurrent_writers_do_not_lose_records(store):
    import threading

    errors = []

    def worker(index):
        try:
            for i in range(5):
                store.create(body=f"body {index} {i}")
        except Exception as exc:  # pragma: no cover - only fires on a real bug
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert store.count() == 20
    assert len(read_raw(store)["prompts"]) == 20


def test_returned_records_are_copies(store):
    rec = store.create(body="a", tags=["t"])
    rec["tags"].append("mutated")
    rec["body"] = "mutated"
    assert store.get(rec["id"])["tags"] == ["t"]
    assert store.get(rec["id"])["body"] == "a"
