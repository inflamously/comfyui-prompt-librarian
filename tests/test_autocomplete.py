"""All vocabulary fixtures live in temporary, synthetic SQLite libraries."""

import json
import sqlite3

import pytest

from prompt_librarian.features.autocomplete import vocabulary as ac
from prompt_librarian.shared.errors import StoreWriteError
from prompt_librarian.shared.library import _INITIALIZED
from tests import uc


def suggestions(store, word="", phrase="", limit=20):
    return uc.suggest(store.lib, word, phrase, limit)


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
    uc.create_prompt(store.lib, "Volumetric lighting, volumetric, violet")
    uc.create_prompt(store.lib, "volumetric lighting, volume")
    result = suggestions(fresh(), "VOL", "vol")
    assert result[:2] == [
        {"text": "Volumetric", "scope": "word", "source_count": 2},
        {"text": "Volumetric lighting", "scope": "phrase", "source_count": 2},
    ]
    assert [item["text"] for item in result[2:]] == ["volume"]
    assert len(suggestions(store, "v", "v", 1)) == 1
    assert suggestions(store) == []


def test_only_current_bodies_and_incremental_metadata(store, monkeypatch):
    rec = uc.create_prompt(store.lib, "before", tags=["tagsecret"], notes="notesecret")
    uc.update_prompt(store.lib, rec["id"], body="after")
    uc.set_snippet(store.lib, "secret", "snippetsecret")
    assert suggestions(store, "before") == []
    for word in ("tagsecret", "notesecret", "snippetsecret", "unsaved"):
        assert suggestions(store, word) == []

    def fail(*args):
        raise AssertionError("metadata must not reindex bodies")

    monkeypatch.setattr(ac, "put", fail)
    uc.update_prompt(store.lib, rec["id"], rating=3, tags=["changed"])
    uc.bulk_retag(store.lib, [rec["id"]], add=["other"])
    assert suggestions(store, "af")[0]["source_count"] == 1


def test_update_restore_usage_delete(store):
    rec = uc.create_prompt(store.lib, "original")
    uc.update_prompt(store.lib, rec["id"], body="edited")
    assert suggestions(store, "original") == []
    uc.restore_version(store.lib, rec["id"], 0)
    assert suggestions(store, "original")
    assert suggestions(store, "edited") == []
    uc.record_usage(store.lib, rec["id"], body="renderedonly")
    assert suggestions(store, "renderedonly") == []
    uc.delete_prompt(store.lib, rec["id"])
    assert suggestions(store, "original") == []


def test_import_replace_merge_and_bulk_paths(store):
    a = uc.create_prompt(store.lib, "alpha shared")
    b = uc.create_prompt(store.lib, "beta shared")
    uc.merge_prompts(store.lib, a["id"], b["id"])
    assert suggestions(store, "shared")[0]["source_count"] == 1
    assert suggestions(store, "beta") == []
    c = uc.create_prompt(store.lib, "gamma shared")
    uc.merge_into_new(store.lib, a["id"], c["id"], "newmerged")
    assert suggestions(store, "alpha") == []
    assert suggestions(store, "newmerged")
    uc.import_library(store.lib, {"prompts": [{"id": "i", "body": "imported"}]}, replace=False)
    assert suggestions(store, "imported")
    uc.import_library(store.lib, {"prompts": [{"id": "r", "body": "replacement"}]}, replace=True)
    assert suggestions(store, "imported") == []
    a = uc.create_prompt(store.lib, "replacement")
    uc.bulk_merge(store.lib, [a["id"], "r"], winner="r")
    assert suggestions(store, "replacement")[0]["source_count"] == 1
    uc.bulk_delete(store.lib, ["r"])
    assert suggestions(store, "replacement") == []
    with store.lib.db.write() as con:
        assert con.execute("SELECT COUNT(*) FROM autocomplete_keywords").fetchone()[0] == 0
    assert "autocomplete" not in json.dumps(uc.export_library(store.lib))


def test_legacy_migration(store, tmp_path):
    path = tmp_path / "synthetic.json"
    path.write_text(json.dumps({"prompts": [{"id": "old", "body": "legacyword"}]}))
    uc.migrate_legacy(store, path)
    assert suggestions(store, "legacy")[0]["source_count"] == 1
    uc.migrate_legacy(store, path)
    assert suggestions(store, "legacy")[0]["source_count"] == 1


def drop_index(store):
    with store.lib.db.write() as con:
        con.execute("DROP TABLE autocomplete_sources")
        con.execute("DROP TABLE autocomplete_keywords")
        con.execute("DELETE FROM state WHERE key='autocomplete_version'")
    _INITIALIZED.pop(store.lib.path, None)


def test_batched_backfill_is_atomic_and_idempotent(store, fresh, monkeypatch):
    for i in range(5):
        uc.create_prompt(store.lib, f"existing {i}")
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
        store.lib.prepare()
    with store.lib.db.write() as con:
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
    _INITIALIZED.pop(store.lib.path, None)
    assert suggestions(fresh(), "existing")[0]["source_count"] == 5


def test_failed_mutation_rolls_back_counts_and_bodies(store, fresh, monkeypatch):
    a = uc.create_prompt(store.lib, "original shared")
    uc.create_prompt(store.lib, "other shared")
    original = ac.put

    def fail(con, pid, body):
        original(con, pid, body)
        raise sqlite3.OperationalError("synthetic failure after indexing")

    monkeypatch.setattr(ac, "put", fail)
    with pytest.raises(StoreWriteError):
        uc.update_prompt(store.lib, a["id"], body="changed")
    check = fresh()
    assert uc.get_prompt(check.lib, a["id"])["body"] == "original shared"
    assert suggestions(check, "shared")[0]["source_count"] == 2
    assert suggestions(check, "changed") == []
    replacement = {"prompts": [{"id": "r", "body": "replacement"}]}
    with pytest.raises(StoreWriteError):
        uc.import_library(store.lib, replacement, replace=True)
    assert suggestions(fresh(), "shared")[0]["source_count"] == 2


def test_literal_prefix_and_index_query_plan(store):
    uc.create_prompt(store.lib, "100% light, 100x light, __clouds__, percent_under")
    assert [x["text"] for x in suggestions(store, phrase="100%")] == ["100% light"]
    assert [x["text"] for x in suggestions(store, phrase="__")] == ["__clouds__"]
    with store.lib.db.write() as con:
        plan = con.execute(
            "EXPLAIN QUERY PLAN " + ac.PREFIX_SQL.format(scope="word"), ("pe", "pf", 8)
        ).fetchall()
        detail = " ".join(row[3] for row in plan)
        assert "SEARCH autocomplete_keywords USING INDEX" in detail
        assert "entries" not in detail


def test_newer_schema_does_not_backfill(store, fresh):
    uc.create_prompt(store.lib, "future")
    uc.update_settings(store.lib, dupe_threshold=0.9)  # writes the metadata row
    drop_index(store)
    with store.lib.db.write() as con:
        row = con.execute("SELECT payload FROM metadata").fetchone()
        meta = json.loads(row[0])
        meta["schema"] = 9999
        con.execute("UPDATE metadata SET payload=?", (json.dumps(meta),))
    assert suggestions(fresh(), "future") == []
    with store.lib.db.write() as con:
        assert not con.execute(
            "SELECT 1 FROM sqlite_master WHERE name='autocomplete_keywords'"
        ).fetchone()


def test_long_sentences_contribute_words_but_not_sentence_completions(store):
    sentence = "Volumetric lighting fills the entire room with a golden glow"
    uc.create_prompt(store.lib, sentence + ", soft light, warm golden glow")
    uc.create_prompt(store.lib, sentence)

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
    rec = uc.create_prompt(store.lib, sentence + ", soft light")
    with store.lib.db.write() as con:
        con.execute(
            "INSERT INTO autocomplete_keywords(keyword,text) VALUES(?,?)",
            (ac.normalize(sentence), sentence),
        )
        con.execute(
            "INSERT INTO autocomplete_sources(prompt_id,keyword,word,phrase) VALUES(?,?,0,1)",
            (rec["id"], ac.normalize(sentence)),
        )
        con.execute("UPDATE state SET value='1' WHERE key='autocomplete_version'")
    _INITIALIZED.pop(store.lib.path, None)

    reopened = fresh()
    assert suggestions(reopened, "vol", "vol") == [
        {"text": "Volumetric", "scope": "word", "source_count": 1},
    ]
    assert suggestions(reopened, phrase="soft")[0]["text"] == "soft light"
    with reopened.lib.db.write() as con:
        assert con.execute(
            "SELECT value FROM state WHERE key='autocomplete_version'"
        ).fetchone()[0] == ac.VERSION
        assert con.execute(
            "SELECT COUNT(*) FROM autocomplete_keywords WHERE keyword=?",
            (ac.normalize(sentence),),
        ).fetchone()[0] == 0
