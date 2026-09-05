"""Public API compatibility across the search feature's module boundaries."""

import importlib
import sys
import types
from pathlib import Path

from prompt_librarian.features import search
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.shared.library import Library


def test_public_scoring_weights_affect_search_and_direct_scoring(monkeypatch):
    records = [
        {"id": "body", "body": "ballet"},
        {"id": "tag", "body": "unrelated", "tags": ["ballet"]},
    ]
    index = search.build_index(records)
    query = search.parse_query("ballet")
    assert search.search(index, "ballet")["hits"][0]["id"] == "body"

    monkeypatch.setattr(search, "W_TAG", 20.0)
    result = search.search(index, "ballet")
    assert result["hits"][0]["id"] == "tag"
    score, mask = search.score_doc(index.docs["tag"], query, index)
    assert result["hits"][0]["score"] == round(score, 6)
    assert mask == 1


def test_public_token_tiers_affect_document_scores(monkeypatch):
    index = search.build_index([{"id": "a", "body": "ballet"}])
    query = search.parse_query("ball")
    before, _ = search.score_doc(index.docs["a"], query, index)
    monkeypatch.setattr(search, "TIER_PREFIX", 0.25)
    assert search.tok("ball", frozenset({"ballet"})) == 0.25
    after, _ = search.score_doc(index.docs["a"], query, index)
    assert after < before


def test_public_invalidation_reaches_the_library_search_cache(tmp_path):
    lib = Library(str(tmp_path / "library.sqlite3"))
    create_prompt(lib, "ballet")
    source = search.LibrarySearchSource(lib)
    search.invalidate_index()
    try:
        index = search.get_index(source)
        assert search.get_index(source) is index
        search.invalidate_index(lib.revision())
        assert search.get_index(source) is not index
    finally:
        search.invalidate_index()
        lib.close()


def test_search_loads_under_comfyui_style_package_name(monkeypatch):
    # Load only the domain's feature packages through a synthetic namespace;
    # the ComfyUI pack entry point and its storage backends are never invoked.
    name = "_search_test_domain"
    parent = types.ModuleType(name)
    # The whole librarian tree, as ComfyUI mounts it: search reaches shared/.
    parent.__path__ = [str(Path(search.__file__).parents[2])]
    monkeypatch.setitem(sys.modules, name, parent)
    try:
        module = importlib.import_module(name + ".features.search")
        index = module.build_index([{"id": "a", "body": "ballet dancer"}], rev=4)
        assert isinstance(index, module.SearchIndex)
        result = module.search(index, "ballet")
        assert result["rev"] == 4
        assert result["hits"][0]["id"] == "a"
        assert result["hits"][0]["label"]
    finally:
        for loaded in list(sys.modules):
            if loaded.startswith(name + "."):
                del sys.modules[loaded]
