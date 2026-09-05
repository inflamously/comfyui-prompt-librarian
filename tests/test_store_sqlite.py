"""Authoritative SQLite storage tests; every path is a synthetic ``tmp_path``."""

import contextlib
import json
import os
import sqlite3
import threading

import pytest

from prompt_librarian.features import search as prompt_search
from prompt_librarian.shared import entries as repository
from prompt_librarian.shared.errors import StoreWriteError
from prompt_librarian.shared.library import _INITIALIZED, Library
from tests import uc


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "library" / "library.sqlite3")


@pytest.fixture
def store(db_path):
    return uc.build(path=db_path, migrate_from=False)


def test_librarian_store_is_authoritative_sqlite(tmp_path):
    made = uc.build(path=str(tmp_path / "library.sqlite3"), migrate_from=False)
    assert uc.storage_status(made)["index"]["state"] == "new"


def test_empty_read_is_lazy_and_crud_survives_a_fresh_instance(store, db_path):
    assert uc.count_prompts(store.lib) == 0
    assert store.search_source.browse() == []
    assert store.search_source.candidates(["anything"], "all") == []
    assert not os.path.exists(db_path)

    rec = uc.create_prompt(store.lib, "cinematic rain", tags=["Weather"], rating=4)
    uc.update_prompt(store.lib, rec["id"], body="cinematic rain at night")
    uc.record_usage(store.lib, rec["id"], body="cinematic rain at night")

    fresh = uc.build(path=db_path, migrate_from=False)
    loaded = uc.get_prompt(fresh.lib, rec["id"])
    assert loaded["body"] == "cinematic rain at night"
    assert loaded["tags"] == ["weather"]
    assert loaded["used"] == 1
    assert loaded["versions"][0]["body"] == "cinematic rain"


def test_database_contains_complete_records_and_search_projections(store, db_path):
    uc.import_library(store.lib,
        {
            "prompts": [
                {
                    "id": "future",
                    "body": "volumetric café lighting",
                    "tags": ["Film"],
                    "future_field": {"kept": True},
                }
            ],
        }
    )
    with sqlite3.connect(db_path) as con:
        row = con.execute(
            "SELECT record_json,body_norm,tags_norm FROM entries WHERE id='future'"
        ).fetchone()
    payload = json.loads(row[0])
    assert payload["future_field"] == {"kept": True}
    assert row[1] == "volumetric café lighting"
    assert row[2] == "film"
    assert store.search_source.candidates(["volumetric"], "all")[0]["id"] == "future"


def test_saves_support_retired_jsonl_index_columns(tmp_path):
    path = str(tmp_path / "library.sqlite3")
    Library(path).prepare()

    # Exact constraints left by the previous authoritative SQLite implementation:
    # these columns had no defaults, so the new INSERT failed on ``off`` first.
    with sqlite3.connect(path) as con:
        con.execute("ALTER TABLE entries ADD COLUMN off INTEGER NOT NULL")
        con.execute("ALTER TABLE entries ADD COLUMN len INTEGER NOT NULL")
        con.execute("ALTER TABLE entries ADD COLUMN seq INTEGER NOT NULL")
    _INITIALIZED.pop(os.path.abspath(path), None)

    store = uc.build(path=path, migrate_from=False)
    created = uc.create_prompt(store.lib, "works after upgrade")
    with sqlite3.connect(path) as con:
        con.execute("UPDATE entries SET off=7,len=11,seq=13 WHERE id=?", (created["id"],))
    updated = uc.update_prompt(store.lib, created["id"], body="still works")

    assert updated["body"] == "still works"
    with sqlite3.connect(path) as con:
        retired = con.execute(
            "SELECT off,len,seq FROM entries WHERE id=?", (created["id"],)
        ).fetchone()
    assert retired == (7, 11, 13)


def test_single_record_edits_do_not_replace_or_scan_the_library(store, monkeypatch):
    records = [uc.create_prompt(store.lib, f"body {index}") for index in range(50)]

    def forbidden(*_args, **_kwargs):
        raise AssertionError("a point edit must not replace the database")

    monkeypatch.setattr(repository, "clear", forbidden)
    monkeypatch.setattr(repository, "ids", forbidden)  # listing every id is a scan
    changed = uc.update_prompt(store.lib, records[25]["id"], body="one changed body")
    assert changed["body"] == "one changed body"
    assert uc.count_prompts(store.lib) == 50


def test_empty_browse_uses_previews_but_reports_full_sizes(store):
    rec = uc.create_prompt(store.lib, "x" * 500)
    uc.update_prompt(store.lib, rec["id"], body="y" * 600)

    projected = store.search_source.browse()[0]
    assert len(projected["body"]) == 160
    assert projected["_chars"] == 600
    assert projected["_version_count"] == 1
    assert len(uc.get_prompt(store.lib, rec["id"])["body"]) == 600

    hit = prompt_search.search(store.search_source, "", limit=10)["hits"][0]
    assert hit["chars"] == 600
    assert hit["version_count"] == 1


def test_settings_snippets_pairs_and_prompt_delete_are_transactional(store, db_path):
    a = uc.create_prompt(store.lib, "a")
    b = uc.create_prompt(store.lib, "b")
    uc.update_settings(store.lib, dupe_threshold=0.7, version_cap=3)
    uc.set_snippet(store.lib, "light", "softbox")
    uc.ignore_pair(store.lib, a["id"], b["id"])
    uc.delete_prompt(store.lib, a["id"])

    fresh = uc.build(path=db_path, migrate_from=False)
    assert uc.read_settings(fresh.lib) == {"dupe_threshold": 0.7, "version_cap": 3}
    assert uc.get_snippet(fresh.lib, "light") == "softbox"
    assert uc.ignored_pairs(fresh.lib) == set()
    assert uc.get_prompt(fresh.lib, a["id"]) is None


def test_independent_writers_do_not_lose_each_others_records(db_path):
    first = uc.build(path=db_path, migrate_from=False)
    second = uc.build(path=db_path, migrate_from=False)
    errors = []

    def write(store, prefix):
        try:
            for index in range(20):
                uc.create_prompt(store.lib, f"{prefix}-{index}")
        except Exception as exc:  # pragma: no cover - only fires on a real race
            errors.append(exc)

    threads = [
        threading.Thread(target=write, args=(first, "a")),
        threading.Thread(target=write, args=(second, "b")),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert uc.count_prompts(first.lib) == 40
    assert uc.count_prompts(second.lib) == 40
    assert uc.count_prompts(uc.build(path=db_path, migrate_from=False).lib) == 40


def test_json_import_export_remains_the_portable_format(store):
    rec = uc.create_prompt(store.lib, "portable", tags=["backup"])
    uc.set_snippet(store.lib, "s", "snippet")
    exported = uc.export_library(store.lib)
    assert exported["prompts"] == [rec]
    assert json.loads(json.dumps(exported))["snippets"]["s"]["body"] == "snippet"

    uc.import_library(store.lib, {"prompts": []}, replace=True)
    assert uc.count_prompts(store.lib) == 0
    assert uc.import_library(store.lib, exported, replace=True) == 1
    assert uc.get_prompt(store.lib, rec["id"])["body"] == "portable"


def test_explicit_json_migration_is_idempotent_and_keeps_source(store, tmp_path):
    source = tmp_path / "library.json"
    source.write_text(
        json.dumps(
            {
                "settings": {"dupe_threshold": 0.1, "version_cap": 2},
                "prompts": [{"id": "legacy", "body": "from json"}],
            }
        ),
        encoding="utf-8",
    )

    result = uc.migrate_legacy(store, str(source))
    assert result == {
        "imported": 1,
        "skipped": 0,
        "collisions": 0,
        "already_migrated": False,
    }
    assert source.is_file()
    assert uc.get_prompt(store.lib, "legacy")["body"] == "from json"
    assert uc.read_settings(store.lib)["dupe_threshold"] == 0.9
    assert uc.migrate_legacy(store, str(source))["already_migrated"] is True
    # An unchanged source is retained as a backup but no longer offered again.
    discovered = uc.build(path=store.lib.path, migrate_from=str(source))
    assert uc.storage_status(discovered)["legacy"]["available"] is False


def test_explicit_jsonl_migration_folds_updates_deletes_and_metadata(store, tmp_path):
    source = tmp_path / "library.jsonl"
    first = {"id": "first", "body": "old", "tags": []}
    updated = {"id": "first", "body": "new", "tags": ["kept"]}
    deleted = {"id": "gone", "body": "remove me", "tags": []}
    events = [
        {"_seq": 1, "_op": "put", **first},
        {"_seq": 2, "_op": "put", **deleted},
        {"_seq": 3, "_op": "put", **updated},
        {"_seq": 4, "_op": "del", "id": "gone"},
        {
            "_seq": 5,
            "_op": "meta",
            "state": {
                "schema": 1,
                "settings": {"dupe_threshold": 0.2, "version_cap": 4},
                "snippets": {"legacy": {"body": "snippet", "updated": "x"}},
                "ignored": [],
            },
        },
    ]
    source.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")

    result = uc.migrate_legacy(store, str(source))
    assert result["imported"] == 1
    assert uc.get_prompt(store.lib, "first")["body"] == "new"
    assert uc.get_prompt(store.lib, "gone") is None
    assert uc.get_snippet(store.lib, "legacy") == "snippet"
    # Merge migration never changes the active database settings.
    assert uc.read_settings(store.lib)["dupe_threshold"] == 0.9


def test_corrupt_primary_database_is_never_replaced(tmp_path):
    path = tmp_path / "library.sqlite3"
    original = b"not a sqlite database"
    path.write_bytes(original)
    store = uc.build(path=str(path), migrate_from=False)

    with pytest.raises(StoreWriteError):
        uc.count_prompts(store.lib)
    assert store.lib.corrupt() is True
    with pytest.raises(StoreWriteError):
        uc.create_prompt(store.lib, "must not overwrite")
    assert path.read_bytes() == original


def test_a_busy_library_is_not_reported_corrupt(store, monkeypatch):
    uc.create_prompt(store.lib, "hello world")

    def locked():
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(store.lib.db, "connection", locked)
    assert store.lib.corrupt() is False


def test_a_locked_read_raises_and_leaves_nothing_behind(store, monkeypatch):
    """No sticky state: the call after a transient failure simply works."""
    rec = uc.create_prompt(store.lib, "hello")

    @contextlib.contextmanager
    def locked():
        raise sqlite3.OperationalError("database is locked")
        yield  # pragma: no cover

    monkeypatch.setattr(store.lib.db, "read", locked)
    with pytest.raises(StoreWriteError):
        uc.get_prompt(store.lib, rec["id"])
    monkeypatch.undo()

    assert store.lib.corrupt() is False
    assert uc.get_prompt(store.lib, rec["id"])["body"] == "hello"
    assert uc.create_prompt(store.lib, "second")["body"] == "second"


def test_storage_status_describes_one_database(store):
    uc.create_prompt(store.lib, "one")
    status = uc.storage_status(store)
    assert status["database_bytes"] > 0
    assert status["index"]["state"] == "ready"
    assert status["records"] == 1
    assert status["legacy"]["available"] is False


def test_optimizing_an_empty_library_keeps_a_valid_database(store):
    result = uc.compact(store)
    assert result["records"] == 0
    assert store.lib.corrupt() is False
    assert uc.count_prompts(store.lib) == 0


def test_only_sqlite_is_durable_after_connections_close(store):
    uc.create_prompt(store.lib, "one file")
    store.lib.close()
    assert sorted(os.listdir(os.path.dirname(store.lib.path))) == ["library.sqlite3"]


def test_legacy_files_are_discovered_but_never_imported_automatically(tmp_path):
    directory = tmp_path / "library"
    directory.mkdir()
    source = directory / "library.json"
    source.write_text(
        json.dumps(
            {
                "prompts": [{"id": "legacy", "body": "not automatic"}],
            }
        ),
        encoding="utf-8",
    )
    store = uc.build(path=str(directory / "library.sqlite3"))

    assert uc.count_prompts(store.lib) == 0
    assert uc.get_prompt(store.lib, "legacy") is None
    assert not os.path.exists(store.lib.path)
    assert uc.storage_status(store)["legacy"]["available"] is True
