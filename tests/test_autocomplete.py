"""All vocabulary fixtures live in temporary, synthetic SQLite libraries."""

import json
import sqlite3

import pytest

from prompt_librarian.store import StoreWriteError
from prompt_librarian.store import autocomplete as ac
from prompt_librarian.store.sqlite_database import _INITIALIZED


def suggestions(store, word="", phrase="", limit=20):
    return store.autocomplete(word, phrase, limit)


def test_extraction_unicode_literals_and_uniqueness():
    result = ac.extract(
        "Volumetric lighting, volumetric  lighting\nＣＡＦÉ cafe\u0301, __clouds__, {a|b}"
    )
    assert result["volumetric"] == ["Volumetric", 1, 0]
    assert result["volumetric lighting"] == ["Volumetric lighting", 0, 1]
    assert result["café"][1:] == [1, 0]
    assert "__clouds__" in result
    assert "{a|b}" in result
    assert ac.extract("  soft  light,soft light")["soft light"] == ["soft  light", 0, 1]
    assert len([key for key in result if key == "café"]) == 1


def test_ranking_counts_scope_and_restart(store, fresh):
    store.create("Volumetric lighting, volumetric, violet")
    store.create("volumetric lighting, volume")
    result = suggestions(fresh(), "VOL", "vol")
    assert result[:2] == [
        {"text": "Volumetric", "scope": "word", "source_count": 2},
        {"text": "Volumetric lighting", "scope": "phrase", "source_count": 2},
    ]
    assert [item["text"] for item in result[2:]] == ["volume"]
    assert len(suggestions(store, "v", "v", 1)) == 1
    assert suggestions(store) == []


def test_only_current_bodies_and_incremental_metadata(store, monkeypatch):
    rec = store.create("before", tags=["tagsecret"], notes="notesecret")
    store.update(rec["id"], body="after")
    store.set_snippet("secret", "snippetsecret")
    assert suggestions(store, "before") == []
    for word in ("tagsecret", "notesecret", "snippetsecret", "unsaved"):
        assert suggestions(store, word) == []

    def fail(*args):
        raise AssertionError("metadata must not reindex bodies")

    monkeypatch.setattr(ac, "put", fail)
    store.update(rec["id"], rating=3, tags=["changed"])
    store.bulk_retag([rec["id"]], add=["other"])
    assert suggestions(store, "af")[0]["source_count"] == 1


def test_update_restore_usage_delete(store):
    rec = store.create("original")
    store.update(rec["id"], body="edited")
    assert suggestions(store, "original") == []
    store.restore_version(rec["id"], 0)
    assert suggestions(store, "original")
    assert suggestions(store, "edited") == []
    store.record_usage(rec["id"], body="renderedonly")
    assert suggestions(store, "renderedonly") == []
    store.delete(rec["id"])
    assert suggestions(store, "original") == []


def test_import_replace_merge_and_bulk_paths(store):
    a = store.create("alpha shared")
    b = store.create("beta shared")
    store.merge(a["id"], b["id"])
    assert suggestions(store, "shared")[0]["source_count"] == 1
    assert suggestions(store, "beta") == []
    c = store.create("gamma shared")
    store.merge_new(a["id"], c["id"], "newmerged")
    assert suggestions(store, "alpha") == []
    assert suggestions(store, "newmerged")
    store.import_raw({"prompts": [{"id": "i", "body": "imported"}]}, replace=False)
    assert suggestions(store, "imported")
    store.import_raw({"prompts": [{"id": "r", "body": "replacement"}]}, replace=True)
    assert suggestions(store, "imported") == []
    a = store.create("replacement")
    store.bulk_merge([a["id"], "r"], winner="r")
    assert suggestions(store, "replacement")[0]["source_count"] == 1
    store.bulk_delete(["r"])
    assert suggestions(store, "replacement") == []
    with store._index._connection() as con:
        assert con.execute("SELECT COUNT(*) FROM autocomplete_keywords").fetchone()[0] == 0
    assert "autocomplete" not in json.dumps(store.export_raw())


def test_legacy_migration(store, tmp_path):
    path = tmp_path / "synthetic.json"
    path.write_text(json.dumps({"prompts": [{"id": "old", "body": "legacyword"}]}))
    store.migrate_legacy(path)
    assert suggestions(store, "legacy")[0]["source_count"] == 1
    store.migrate_legacy(path)
    assert suggestions(store, "legacy")[0]["source_count"] == 1


def drop_index(store):
    with store._index._connection() as con:
        con.execute("DROP TABLE autocomplete_sources")
        con.execute("DROP TABLE autocomplete_keywords")
        con.execute("DELETE FROM state WHERE key='autocomplete_version'")
    _INITIALIZED.pop(store._index.path, None)


def test_batched_backfill_is_atomic_and_idempotent(store, fresh, monkeypatch):
    for i in range(5):
        store.create(f"existing {i}")
    drop_index(store)
    monkeypatch.setattr(ac, "BATCH_SIZE", 2)
    original = ac.put
    calls = []

    def fail(con, pid, body):
        calls.append(pid)
        original(con, pid, body)
        if len(calls) == 3:
            raise sqlite3.OperationalError("synthetic interrupted backfill")

    monkeypatch.setattr(ac, "put", fail)
    with pytest.raises(sqlite3.OperationalError):
        store._index.initialize()
    with store._index._connection() as con:
        assert con.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 5
        assert (
            con.execute("SELECT value FROM state WHERE key='autocomplete_version'").fetchone()
            is None
        )
    monkeypatch.setattr(ac, "put", original)
    assert suggestions(fresh(), "existing")[0]["source_count"] == 5

    def unexpected(*args):
        raise AssertionError("backfill ran twice")

    monkeypatch.setattr(ac, "put", unexpected)
    _INITIALIZED.pop(store._index.path, None)
    assert suggestions(fresh(), "existing")[0]["source_count"] == 5


def test_failed_mutation_rolls_back_counts_and_bodies(store, fresh, monkeypatch):
    a = store.create("original shared")
    store.create("other shared")
    original = ac.put

    def fail(con, pid, body):
        original(con, pid, body)
        raise sqlite3.OperationalError("synthetic failure after indexing")

    monkeypatch.setattr(ac, "put", fail)
    with pytest.raises(StoreWriteError):
        store.update(a["id"], body="changed")
    check = fresh()
    assert check.get(a["id"])["body"] == "original shared"
    assert suggestions(check, "shared")[0]["source_count"] == 2
    assert suggestions(check, "changed") == []
    with pytest.raises(StoreWriteError):
        store.import_raw({"prompts": [{"id": "r", "body": "replacement"}]}, replace=True)
    assert suggestions(fresh(), "shared")[0]["source_count"] == 2


def test_literal_prefix_and_index_query_plan(store):
    store.create("100% light, 100x light, __clouds__, percent_under")
    assert [x["text"] for x in suggestions(store, phrase="100%")] == ["100% light"]
    assert [x["text"] for x in suggestions(store, phrase="__")] == ["__clouds__"]
    with store._index._connection() as con:
        plan = con.execute(
            "EXPLAIN QUERY PLAN " + ac.PREFIX_SQL.format(scope="word"), ("pe", "pf", 8)
        ).fetchall()
        detail = " ".join(row[3] for row in plan)
        assert "SEARCH autocomplete_keywords USING INDEX" in detail
        assert "entries" not in detail


def test_newer_schema_does_not_backfill(store, fresh):
    store.create("future")
    store._save_meta()
    drop_index(store)
    with store._index._connection() as con:
        row = con.execute("SELECT payload FROM metadata").fetchone()
        meta = json.loads(row[0])
        meta["schema"] = 9999
        con.execute("UPDATE metadata SET payload=?", (json.dumps(meta),))
    assert suggestions(fresh(), "future") == []
    with store._index._connection() as con:
        assert not con.execute(
            "SELECT 1 FROM sqlite_master WHERE name='autocomplete_keywords'"
        ).fetchone()


def test_long_sentences_contribute_words_but_not_sentence_completions(store):
    sentence = "Volumetric lighting fills the entire room with a golden glow"
    store.create(sentence + ", soft light, warm golden glow")
    store.create(sentence)

    result = suggestions(store, "vol", "vol")
    assert result == [{"text": "Volumetric", "scope": "word", "source_count": 2}]
    assert suggestions(store, phrase="Volumetric lighting fills") == []
    assert suggestions(store, phrase="soft")[0]["text"] == "soft light"
    assert suggestions(store, phrase="warm")[0]["text"] == "warm golden glow"
    assert suggestions(store, "gold")[0]["source_count"] == 2


def test_short_phrases_use_unicode_words_not_just_spaces():
    result = ac.extract("soft-light, warm/golden/soft/light, café très doux, ...")
    assert result["soft-light"] == ["soft-light", 0, 1]
    assert result["café très doux"] == ["café très doux", 0, 1]
    assert "warm/golden/soft/light" not in result
    assert "..." not in result
    assert result["golden"] == ["golden", 1, 0]


def test_upgrade_removes_previously_learned_sentences(store, fresh):
    sentence = "Volumetric lighting fills the entire room"
    rec = store.create(sentence + ", soft light")
    with store._index._connection() as con:
        con.execute(
            "INSERT INTO autocomplete_keywords(keyword,text) VALUES(?,?)",
            (ac.normalize(sentence), sentence),
        )
        con.execute(
            "INSERT INTO autocomplete_sources(prompt_id,keyword,word,phrase) VALUES(?,?,0,1)",
            (rec["id"], ac.normalize(sentence)),
        )
        con.execute("UPDATE state SET value='1' WHERE key='autocomplete_version'")
    _INITIALIZED.pop(store._index.path, None)

    reopened = fresh()
    assert suggestions(reopened, "vol", "vol") == [
        {"text": "Volumetric", "scope": "word", "source_count": 1},
    ]
    assert suggestions(reopened, phrase="soft")[0]["text"] == "soft light"
    with reopened._index._connection() as con:
        assert con.execute(
            "SELECT value FROM state WHERE key='autocomplete_version'"
        ).fetchone()[0] == ac.VERSION
        assert con.execute(
            "SELECT COUNT(*) FROM autocomplete_keywords WHERE keyword=?",
            (ac.normalize(sentence),),
        ).fetchone()[0] == 0
