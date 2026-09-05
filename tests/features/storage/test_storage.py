"""Export, import, legacy migration, health and compaction on a bare Library."""

import json

import pytest

from prompt_librarian.features.library import snippets
from prompt_librarian.features.prompts import get
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.features.storage import compact, export, health, importing, migrate
from prompt_librarian.shared.errors import NotFoundError


def test_export_then_replace_import_restores_the_library(lib):
    rec = create_prompt(lib, "keep me", tags=["t"])
    snippets.set_snippet(lib, "s", "body")
    dump = export.export_library(lib)
    assert [p["id"] for p in dump["prompts"]] == [rec["id"]]
    keys = {"schema", "updated", "settings", "snippets", "ignored"}
    assert set(export.export_metadata(lib)) == keys

    create_prompt(lib, "added later")
    assert importing.import_library(lib, dump, replace=True) == 1
    assert get.prompt_ids(lib) == [rec["id"]]
    assert snippets.get_snippet(lib, "s") == "body"


def test_merge_import_renames_colliding_ids_and_unions_snippets(lib):
    rec = create_prompt(lib, "resident")
    snippets.set_snippet(lib, "mine", "x")
    incoming = {"prompts": [{"id": rec["id"], "body": "incoming"}], "snippets": {"theirs": "y"}}
    assert importing.import_library(lib, incoming, replace=False) == 1
    bodies = sorted(r["body"] for r in get.all_prompts(lib))
    assert bodies == ["incoming", "resident"]
    assert snippets.get_snippet(lib, "mine") == "x"
    assert snippets.get_snippet(lib, "theirs") == "y"


def test_junk_imports_as_an_empty_library(lib):
    assert importing.import_library(lib, "total garbage") == 0


def test_legacy_migration_runs_once_per_file_version(lib, tmp_path):
    source = tmp_path / "library.json"
    source.write_text(json.dumps({"prompts": [{"id": "old", "body": "legacy"}]}), "utf-8")
    assert migrate.pending_sources(lib, [str(source)]) == [str(source)]
    first = migrate.migrate_legacy(lib, str(source))
    assert first["imported"] == 1
    again = migrate.migrate_legacy(lib, str(source))
    assert again["already_migrated"] is True
    assert migrate.pending_sources(lib, [str(source)]) == []
    with pytest.raises(NotFoundError):
        migrate.migrate_legacy(lib, str(tmp_path / "missing.json"))


def test_legacy_sources_sit_beside_the_library(tmp_path):
    library = tmp_path / "library.sqlite3"
    (tmp_path / "library.jsonl").write_text("", "utf-8")
    assert migrate.legacy_sources(str(library)) == [str(tmp_path / "library.jsonl")]
    assert migrate.legacy_sources(str(library), migrate_from=False) == []


def test_health_and_compact(lib):
    assert health.health(lib)["state"] == "new"
    create_prompt(lib, "x")
    assert health.health(lib)["state"] == "ready"
    before, after = compact.compact(lib)
    assert before > 0 and after > 0
    status = health.storage_status(lib, [])
    assert status["records"] == 1
    assert status["legacy"] == {"available": False, "bytes": 0, "sources": []}
