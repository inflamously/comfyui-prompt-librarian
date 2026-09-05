import pytest

from prompt_librarian.features.dictionary import (
    define,
    dictionary_status,
    install,
    search_words,
)
from prompt_librarian.features.dictionary.http import ServiceUnavailableError

from .wordnet_fixture import FILES, FakeGet, archive


@pytest.fixture
def root(tmp_path):
    folder = str(tmp_path / "dictionary")
    install(folder, get=FakeGet())
    return folder


def test_not_installed_until_downloaded(tmp_path):
    folder = str(tmp_path / "dictionary")
    assert define(folder, "misty")["status"] == "not_installed"
    assert search_words(folder, "mi") == {"installed": False, "words": []}
    assert dictionary_status(folder)["installed"] is False


def test_install_downloads_once(tmp_path):
    folder = str(tmp_path / "dictionary")
    get = FakeGet()
    status = install(folder, get=get)
    assert status["installed"] is True
    assert status["words"] == 8
    assert "WordNet" in status["source"]
    install(folder, get=FakeGet(error=AssertionError("must not download again")))
    assert len(get.urls) == 1


def test_failed_download_writes_nothing(tmp_path):
    folder = str(tmp_path / "dictionary")
    with pytest.raises(ServiceUnavailableError):
        install(folder, get=FakeGet(error=ServiceUnavailableError("blocked")))
    with pytest.raises(ServiceUnavailableError):
        install(folder, get=FakeGet(body=b"<html>not a zip</html>"))
    assert dictionary_status(folder)["installed"] is False


def test_wrong_archive_is_rejected(tmp_path):
    folder = str(tmp_path / "dictionary")
    with pytest.raises(ValueError, match="not a WordNet archive"):
        install(folder, get=FakeGet(body=archive({"README": "hi"})))
    assert dictionary_status(folder)["installed"] is False


def test_definition_examples_and_antonyms(root):
    got = define(root, "  Dark ")
    assert got["status"] == "found"
    [meaning] = got["meanings"]
    assert meaning == {
        "part": "adjective", "definitions": ["devoid of light"], "examples": ["a dark room"],
        "synonyms": [], "antonyms": ["light"],
    }


def test_satellite_borrows_its_heads_opposite(root):
    [meaning] = define(root, "misty")["meanings"]
    assert meaning["definitions"] == ["filled with mist"]
    assert meaning["examples"] == ["a misty morning"]
    assert meaning["synonyms"] == ["foggy"], "position markers like (a) are stripped"
    assert meaning["antonyms"] == ["light"]


def test_parts_of_speech_are_separate(root):
    parts = [m["part"] for m in define(root, "light")["meanings"]]
    assert parts == ["noun", "adjective"], "nouns first, then adjectives"


def test_inflections_find_their_base_form(root):
    assert define(root, "forests")["lemma"] == "forest"
    geese = define(root, "geese")
    assert geese["lemma"] == "goose"
    assert geese["meanings"][0]["synonyms"] == []
    assert define(root, "forest")["meanings"][0]["synonyms"] == ["wood"]


def test_missing_phrase_lists_known_parts(root):
    got = define(root, "golden hour")
    assert got["status"] == "missing"
    assert got["parts"] == ["hour"]
    assert define(root, "zzzq")["parts"] == []


def test_search_is_prefix_exact_first(root):
    assert search_words(root, "li")["words"] == ["light"]
    assert search_words(root, "FO")["words"] == ["foggy", "forest"]
    assert search_words(root, "")["words"] == []
    assert search_words(root, "dark", limit=1)["words"] == ["dark"]


def test_empty_word_is_rejected(root):
    with pytest.raises(ValueError, match="empty"):
        define(root, "   ")


def test_fixture_is_in_wordnet_format():
    assert all(name.startswith(("data.", "index.", "noun.")) for name in FILES)
