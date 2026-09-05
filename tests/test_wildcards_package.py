"""Compatibility checks for the wildcard package's public entry points."""

import importlib
import importlib.util
import sys
import types
from pathlib import Path

import pytest

from prompt_librarian.features import wildcards as wc
from prompt_librarian.features.wildcards import sources
from prompt_librarian.shared import paths


def test_shared_files_override_reaches_all_entry_points(tmp_path, monkeypatch):
    (tmp_path / "mood.txt").write_text("calm", encoding="utf-8")
    files = wc.WildcardFiles(str(tmp_path))
    monkeypatch.setattr(wc, "FILES", files)

    assert wc.names() == ["mood"]
    assert wc.signature() == files.dir_signature()
    assert wc.resolve("__mood__", snippets={}) == "calm"
    assert wc.resolve_verbose("__mood__", snippets={})["text"] == "calm"


@pytest.mark.parametrize(
    ("limit", "value", "expected", "warning"),
    [
        ("MAX_DEPTH", 1, "[[b]]", "expanded too many times"),
        ("MAX_PASSES", 1, "[[b]]", "stopped after 1 passes"),
    ],
)
def test_public_limits_reach_resolution(monkeypatch, limit, value, expected, warning):
    monkeypatch.setattr(wc, limit, value)
    out = wc.resolve_verbose("[[a]]", snippets={"a": "[[b]]", "b": "[[b]]"})
    assert out["text"] == expected
    assert any(warning in item for item in out["warnings"])


def test_default_snippets_are_loaded_only_when_needed(monkeypatch):
    calls = []
    monkeypatch.setattr(
        sources, "_snippets_provider", lambda: calls.append(True) or {"a": "calm"}
    )

    assert wc.resolve("plain") == "plain"
    assert wc.resolve("[[a]]", snippets={"a": "explicit"}) == "explicit"
    assert calls == []
    assert wc.resolve("[[a]]") == "calm"
    assert calls == [True]


def test_the_default_directory_sits_next_to_the_library(user_dir):
    assert wc.WildcardFiles().root() == paths.wildcards_dir()
    assert wc.WildcardFiles().root().startswith(str(user_dir))


@pytest.mark.parametrize("configured", [True, False])
def test_file_location_import_is_lazy_and_configurable(tmp_path, monkeypatch, configured):
    # ComfyUI loads beneath its own package name, so mount the librarian tree
    # under a synthetic one; the pack root and ComfyUI are never imported.
    name = "_wildcard_test_domain"
    parent = types.ModuleType(name)
    parent.__path__ = [str(Path(wc.__file__).parents[2])]
    monkeypatch.setitem(sys.modules, name, parent)
    calls = []
    try:
        module = importlib.import_module(name + ".features.wildcards")
        assert module.resolve("{only}", snippets={}) == "only"
        if configured:
            module.configure(
                root=lambda: calls.append("files") or str(tmp_path),
                snippets=lambda: calls.append("snippets") or {"a": "calm"},
            )
        assert calls == [], "configuring reads nothing"
        assert module.resolve("[[a]]") == ("calm" if configured else "[[a]]")
        if configured:
            assert module.FILES.root() == str(tmp_path)
            assert calls == ["snippets", "files"]
    finally:
        for loaded in list(sys.modules):
            if loaded.startswith(name + "."):
                del sys.modules[loaded]
