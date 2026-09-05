"""Which words the generator is offered."""

import pytest

from prompt_librarian.features import word_images
from prompt_librarian.features.word_images import _index
from prompt_librarian.features.word_images.candidates import is_filler


@pytest.mark.parametrize("word", [
    "a", "the", "with", "masterpiece", "Best Quality", "8k", "1.2", "(:", "ab",
    "score_9", "very detailed", "highres", "of the",
])
def test_filler_is_skipped(word):
    assert is_filler(word)


@pytest.mark.parametrize("word", ["fox", "red fox", "cathedral", "1girl", "the forest", "bokeh"])
def test_things_a_picture_can_show_are_kept(word):
    assert not is_filler(word)


def test_candidates_keep_order_skip_taken_and_duplicates(tmp_path):
    root = str(tmp_path)
    _index.write_index(root, {"cat": {"v": 1, "src": "generated", "page": "", "size": 1}})
    _index.write_misses(root, {"dog": 1.0})
    keywords = [("Fox", 9), ("cat", 8), ("the", 7), ("dog", 6), ("fox", 5), ("Owl", 1)]
    assert word_images.picture_candidates(root, keywords) == (["Fox", "Owl"], 2)
    assert word_images.picture_candidates(root, keywords, limit=1) == (["Fox"], 2)


def test_attach_records_whether_it_was_generated(tmp_path):
    image = pytest.importorskip("PIL.Image")
    png = tmp_path / "a.png"
    image.new("RGB", (64, 64)).save(png)
    root = str(tmp_path / "pics")
    made = word_images.attach_word_image(root, "fox", str(png), "generated")
    assert made["source"] == "generated"
    assert word_images.attach_word_image(root, "owl", str(png), "bogus")["source"] == "manual"
