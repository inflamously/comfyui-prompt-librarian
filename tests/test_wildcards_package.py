"""Compatibility checks for the wildcard package's public entry points."""

import importlib.util
import sys
import types
from pathlib import Path

import pytest

from prompt_librarian import wildcards as wc
from prompt_librarian.wildcards import sources


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
    store = types.SimpleNamespace(snippets=lambda: calls.append(True) or {"a": "calm"})
    monkeypatch.setattr(sources, "_STORE", store)

    assert wc.resolve("plain") == "plain"
    assert wc.resolve("[[a]]", snippets={"a": "explicit"}) == "explicit"
    assert calls == []
    assert wc.resolve("[[a]]") == "calm"
    assert calls == [True]


def test_fallback_directory_does_not_gain_an_extra_wildcards_component(tmp_path, monkeypatch):
    package = tmp_path / "prompt_librarian" / "wildcards"
    monkeypatch.setattr(sources, "__file__", str(package / "sources.py"))
    monkeypatch.setattr(sources, "_STORE", None)
    monkeypatch.setattr(sources, "_store_wildcards_dir", None)

    assert wc.WildcardFiles().root() == str(package)


@pytest.mark.parametrize("with_store", [True, False])
def test_file_location_import_is_lazy_and_supports_optional_store(
    tmp_path, monkeypatch, with_store
):
    # ComfyUI loads beneath its own package name. A synthetic parent prevents
    # this check from importing the pack root or any real ComfyUI modules.
    parent_name = "_wildcard_test_domain"
    parent = types.ModuleType(parent_name)
    parent.__path__ = []
    monkeypatch.setitem(sys.modules, parent_name, parent)
    calls = []
    store_module = types.ModuleType(parent_name + ".store")
    store_module.STORE = types.SimpleNamespace(
        wildcards_dir=lambda: calls.append("files") or str(tmp_path),
        snippets=lambda: calls.append("snippets") or {"a": "calm"},
    )
    store_module.wildcards_dir = lambda: str(tmp_path)
    monkeypatch.setitem(sys.modules, store_module.__name__, store_module if with_store else None)

    name = parent_name + ".wildcards"
    spec = importlib.util.spec_from_file_location(name, Path(wc.__file__))
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    try:
        spec.loader.exec_module(module)
        assert calls == []
        assert module.resolve("{only}", snippets={}) == "only"
        assert calls == []
        assert module.resolve("[[a]]") == ("calm" if with_store else "[[a]]")
        if with_store:
            assert module.FILES.root() == str(tmp_path)
            assert calls == ["snippets", "files"]
    finally:
        for loaded in list(sys.modules):
            if loaded.startswith(name + "."):
                del sys.modules[loaded]
