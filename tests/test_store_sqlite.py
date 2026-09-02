"""Authoritative SQLite storage tests; every path is a synthetic ``tmp_path``."""

import json
import os
import sqlite3
import threading

import pytest

from prompt_librarian import search as prompt_search
from prompt_librarian.store import (
    LibrarianStore,
    StoreWriteError,
)
from prompt_librarian.store.sqlite_database import _INITIALIZED, SQLiteDatabase


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "library" / "library.sqlite3")


@pytest.fixture
def store(db_path):
    return LibrarianStore(path=db_path, migrate_from=False)


def test_librarian_store_is_authoritative_sqlite(tmp_path):
    made = LibrarianStore(path=str(tmp_path / "library.sqlite3"), migrate_from=False)
    assert made.storage_status()["index"]["state"] == "new"


def test_empty_read_is_lazy_and_crud_survives_a_fresh_instance(store, db_path):
    assert store.count() == 0
    assert store.list_search_records() == []
    assert store.search_candidate_records(["anything"]) == []
    assert not os.path.exists(db_path)

    rec = store.create("cinematic rain", tags=["Weather"], rating=4)
    store.update(rec["id"], body="cinematic rain at night")
    store.record_usage(rec["id"], body="cinematic rain at night")

    fresh = LibrarianStore(path=db_path, migrate_from=False)
    loaded = fresh.get(rec["id"])
    assert loaded["body"] == "cinematic rain at night"
    assert loaded["tags"] == ["weather"]
    assert loaded["used"] == 1
    assert loaded["versions"][0]["body"] == "cinematic rain"


def test_database_contains_complete_records_and_search_projections(store, db_path):
    store.import_raw(
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
    assert store.search_candidate_records(["volumetric"])[0]["id"] == "future"


def test_saves_support_retired_jsonl_index_columns(tmp_path):
    path = str(tmp_path / "library.sqlite3")
    database = SQLiteDatabase(path)
    database.initialize()

    # Exact constraints left by the previous authoritative SQLite implementation:
    # these columns had no defaults, so the new INSERT failed on ``off`` first.
    with sqlite3.connect(path) as con:
        con.execute("ALTER TABLE entries ADD COLUMN off INTEGER NOT NULL")
        con.execute("ALTER TABLE entries ADD COLUMN len INTEGER NOT NULL")
        con.execute("ALTER TABLE entries ADD COLUMN seq INTEGER NOT NULL")
    _INITIALIZED.pop(os.path.abspath(path), None)

    store = LibrarianStore(path=path, migrate_from=False)
    created = store.create("works after upgrade")
    with sqlite3.connect(path) as con:
        con.execute("UPDATE entries SET off=7,len=11,seq=13 WHERE id=?", (created["id"],))
    updated = store.update(created["id"], body="still works")

    assert updated["body"] == "still works"
    with sqlite3.connect(path) as con:
        retired = con.execute(
            "SELECT off,len,seq FROM entries WHERE id=?", (created["id"],)
        ).fetchone()
    assert retired == (7, 11, 13)


def test_single_record_edits_do_not_replace_or_scan_the_library(store, monkeypatch):
    records = [store.create(f"body {index}") for index in range(50)]

    def forbidden(*_args, **_kwargs):
        raise AssertionError("a point edit must not replace the database")

    monkeypatch.setattr(store._index, "replace_authoritative", forbidden)
    monkeypatch.setattr(store, "all", forbidden)
    changed = store.update(records[25]["id"], body="one changed body")
    assert changed["body"] == "one changed body"
    assert store.count() == 50


def test_empty_browse_uses_previews_but_reports_full_sizes(store):
    rec = store.create("x" * 500)
    store.update(rec["id"], body="y" * 600)

    projected = store.list_search_records()[0]
    assert len(projected["body"]) == 160
    assert projected["_chars"] == 600
    assert projected["_version_count"] == 1
    assert len(store.get(rec["id"])["body"]) == 600

    hit = prompt_search.search(store, "", limit=10)["hits"][0]
    assert hit["chars"] == 600
    assert hit["version_count"] == 1


def test_settings_snippets_pairs_and_prompt_delete_are_transactional(store, db_path):
    a = store.create("a")
    b = store.create("b")
    store.set_settings(dupe_threshold=0.7, version_cap=3)
    store.set_snippet("light", "softbox")
    store.ignore_pair(a["id"], b["id"])
    store.delete(a["id"])

    fresh = LibrarianStore(path=db_path, migrate_from=False)
    assert fresh.settings() == {"dupe_threshold": 0.7, "version_cap": 3}
    assert fresh.get_snippet("light") == "softbox"
    assert fresh.ignored_pairs() == set()
    assert fresh.get(a["id"]) is None


def test_independent_writers_do_not_lose_each_others_records(db_path):
    first = LibrarianStore(path=db_path, migrate_from=False)
    second = LibrarianStore(path=db_path, migrate_from=False)
    errors = []

    def write(store, prefix):
        try:
            for index in range(20):
                store.create(f"{prefix}-{index}")
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
    assert first.count() == 40
    assert second.count() == 40
    assert LibrarianStore(path=db_path, migrate_from=False).count() == 40


def test_json_import_export_remains_the_portable_format(store):
    rec = store.create("portable", tags=["backup"])
    store.set_snippet("s", "snippet")
    exported = store.export_raw()
    assert exported["prompts"] == [rec]
    assert json.loads(json.dumps(exported))["snippets"]["s"]["body"] == "snippet"

    store.import_raw({"prompts": []}, replace=True)
    assert store.count() == 0
    assert store.import_raw(exported, replace=True) == 1
    assert store.get(rec["id"])["body"] == "portable"


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

    result = store.migrate_legacy(str(source))
    assert result == {
        "imported": 1,
        "skipped": 0,
        "collisions": 0,
        "already_migrated": False,
    }
    assert source.is_file()
    assert store.get("legacy")["body"] == "from json"
    assert store.settings()["dupe_threshold"] == 0.9
    assert store.migrate_legacy(str(source))["already_migrated"] is True
    # An unchanged source is retained as a backup but no longer offered again.
    discovered = LibrarianStore(path=store.store_path(), migrate_from=str(source))
    assert discovered.storage_status()["legacy"]["available"] is False


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

    result = store.migrate_legacy(str(source))
    assert result["imported"] == 1
    assert store.get("first")["body"] == "new"
    assert store.get("gone") is None
    assert store.get_snippet("legacy") == "snippet"
    # Merge migration never changes the active database settings.
    assert store.settings()["dupe_threshold"] == 0.9


def test_corrupt_primary_database_is_never_replaced(tmp_path):
    path = tmp_path / "library.sqlite3"
    original = b"not a sqlite database"
    path.write_bytes(original)
    store = LibrarianStore(path=str(path), migrate_from=False)

    assert store.count() == 0
    assert store.is_corrupt() is True
    with pytest.raises(StoreWriteError):
        store.create("must not overwrite")
    assert path.read_bytes() == original


def test_storage_status_describes_one_database(store):
    store.create("one")
    status = store.storage_status()
    assert status["database_bytes"] > 0
    assert status["index"]["state"] == "ready"
    assert status["records"] == 1
    assert status["legacy"]["available"] is False


def test_optimizing_an_empty_library_keeps_a_valid_database(store):
    result = store.compact()
    assert result["records"] == 0
    assert store.is_corrupt() is False
    assert store.count() == 0


def test_only_sqlite_is_durable_after_connections_close(store):
    store.create("one file")
    store.close()
    assert sorted(os.listdir(store.store_dir())) == ["library.sqlite3"]


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
    store = LibrarianStore(path=str(directory / "library.sqlite3"))

    assert store.count() == 0
    assert store.get("legacy") is None
    assert not os.path.exists(store.store_path())
    assert store.storage_status()["legacy"]["available"] is True
