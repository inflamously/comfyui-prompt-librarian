"""Settings, snippets, muted pairs and the taxonomy, on a bare Library."""

import pytest

from prompt_librarian.features.library import ignored, settings, snippets, taxonomy
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.features.prompts.delete import delete_prompt
from prompt_librarian.shared.errors import NotFoundError


def test_settings_default_clamp_and_change_only_what_is_given(lib):
    assert settings.read_settings(lib) == {"dupe_threshold": 0.9, "version_cap": 50}
    assert settings.update_settings(lib, dupe_threshold=2)["dupe_threshold"] == 1.0
    assert settings.update_settings(lib, version_cap=7) == {"dupe_threshold": 1.0, "version_cap": 7}
    assert settings.version_cap(lib) == 7
    with pytest.raises(ValueError, match="dupe_threshold"):
        settings.update_settings(lib, dupe_threshold="high")


def test_snippets_round_trip(lib, changes):
    snippets.set_snippet(lib, "  style ", "soft light")
    assert snippets.get_snippet(lib, "style") == "soft light"
    assert set(snippets.list_snippets(lib)) == {"style"}
    snippets.delete_snippet(lib, "style")
    before = len(changes)
    with pytest.raises(NotFoundError):
        snippets.delete_snippet(lib, "style")
    assert len(changes) == before, "a failed delete commits nothing"
    with pytest.raises(ValueError, match="empty"):
        snippets.set_snippet(lib, "  ", "x")


def test_muting_is_order_independent_and_idempotent(lib, changes):
    assert ignored.ignore_pair(lib, "b", "a") is True
    before = len(changes)
    assert ignored.ignore_pair(lib, "a", "b") is False
    assert len(changes) == before, "a no-op mute commits nothing"
    assert ignored.is_ignored(lib, "a", "b")
    assert ignored.ignored_pairs(lib) == {("a", "b")}
    assert ignored.unignore_pair(lib, "b", "a") is True
    assert ignored.unignore_pair(lib, "a", "b") is False
    with pytest.raises(ValueError, match="distinct"):
        ignored.ignore_pair(lib, "a", "a")


def test_deleting_a_record_forgets_its_muted_pairs_in_the_same_commit(lib, changes):
    lib.extend(projector=ignored.forget_deleted)
    a, b = create_prompt(lib, "a"), create_prompt(lib, "b")
    ignored.ignore_pair(lib, a["id"], b["id"])
    delete_prompt(lib, a["id"])
    assert ignored.ignored_pairs(lib) == set()
    assert changes[-1].op == "delete"


def test_taxonomy_counts_tags_and_records(lib):
    assert taxonomy.taxonomy(lib) == {"tags": [], "total": 0}
    create_prompt(lib, "one", tags=["x", "y"])
    create_prompt(lib, "two", tags=["y"])
    assert taxonomy.taxonomy(lib) == {
        "tags": [{"tag": "y", "count": 2}, {"tag": "x", "count": 1}],
        "total": 2,
    }
