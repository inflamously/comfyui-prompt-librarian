"""Public API compatibility across the search feature's module boundaries."""

import importlib
import sys
import types
from pathlib import Path

from prompt_librarian import search


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


def test_public_invalidation_reaches_store_search_cache():
    records = [{"id": "a", "body": "ballet"}]
    store = types.SimpleNamespace(rev=lambda: 7, list_all=lambda: records)
    search.invalidate_index()
    try:
        index = search.get_index(store)
        assert search.search(store, "ballet")["total"] == 1
        records.append({"id": "b", "body": "ballet dancer"})
        assert search.get_index(store) is index
        search.invalidate_index(7)
        assert search.search(store, "ballet")["total"] == 2
        assert search.get_index(store) is not index
    finally:
        search.invalidate_index()


def test_search_loads_under_comfyui_style_package_name(monkeypatch):
    # Load only the domain's feature packages through a synthetic namespace;
    # the ComfyUI pack entry point and its storage backends are never invoked.
    name = "_search_test_domain"
    parent = types.ModuleType(name)
    parent.__path__ = [str(Path(search.__file__).parent.parent)]
    monkeypatch.setitem(sys.modules, name, parent)
    try:
        module = importlib.import_module(name + ".search")
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
