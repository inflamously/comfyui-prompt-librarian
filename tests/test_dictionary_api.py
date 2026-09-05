"""The gallery and dictionary routes, driven directly like ``tests/test_api.py``."""

import os

import pytest

pytest.importorskip("aiohttp")

from prompt_librarian.features.dictionary import install  # noqa: E402
from prompt_librarian.features.dictionary.http import ServiceUnavailableError  # noqa: E402
from prompt_librarian.features.prompts.create import create_prompt  # noqa: E402
from tests.features.dictionary.wordnet_fixture import FakeGet  # noqa: E402
from tests.test_word_images_api import _call, _json, routes, store  # noqa: E402, F401


def _fake_download(monkeypatch, get):
    monkeypatch.setattr(install, "__defaults__", (get,))


def test_gallery_lists_vocabulary_without_filler(routes, store):  # noqa: F811
    create_prompt(store.lib, "misty forest, golden hour", [])
    create_prompt(store.lib, "misty lake", [])
    create_prompt(store.lib, "a masterpiece of the sea", [])
    status, data = _json(_call(routes, "get", "/gallery", query={"limit": "50"}))
    assert status == 200, data
    by_word = {w["word"].lower(): w for w in data["words"]}
    assert by_word["misty"]["uses"] == 2
    assert by_word["misty"]["picture"] is None
    assert not set(by_word) & {"a", "of", "the", "masterpiece"}, "filler is left out"
    assert data["words"][0]["uses"] >= data["words"][-1]["uses"]


def test_install_then_define_and_search(routes, store, monkeypatch):  # noqa: F811
    _status, before = _json(_call(routes, "get", "/dictionary", query={"word": "misty"}))
    assert before["status"] == "not_installed"
    _fake_download(monkeypatch, FakeGet())
    status, installed = _json(_call(routes, "post", "/dictionary/install",
                                    body={"source": "wordnet"}))
    assert status == 200, installed
    assert installed["installed"] is True
    assert installed["error"] == ""
    folder = os.path.join(os.path.dirname(store.lib.path), "dictionary")
    assert os.path.isfile(os.path.join(folder, "wordnet.sqlite3")), "beside the library"
    _status, misty = _json(_call(routes, "get", "/dictionary", query={"word": "misty"}))
    assert misty["status"] == "found"
    assert misty["meanings"][0]["antonyms"] == ["light"]
    _status, found = _json(_call(routes, "get", "/dictionary/search", query={"q": "fo"}))
    assert found == {"installed": True, "words": ["foggy", "forest"], "rev": found["rev"]}


def test_failed_install_reports_the_reason(routes, store, monkeypatch):  # noqa: F811
    _fake_download(monkeypatch, FakeGet(error=ServiceUnavailableError("403 blocked")))
    status, data = _json(_call(routes, "post", "/dictionary/install", body={"source": "wordnet"}))
    assert status == 200
    assert data["installed"] is False
    assert "403" in data["error"]


def test_dictionary_route_rejects_empty_word(routes, store):  # noqa: F811
    status, _data = _json(_call(routes, "get", "/dictionary", query={"word": ""}))
    assert status == 400
