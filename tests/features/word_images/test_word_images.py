"""Word pictures: thumbnails of synthetic images in tmp_path, never a real user dir."""

import os

import pytest

Image = pytest.importorskip("PIL.Image")

from prompt_librarian.features import word_images  # noqa: E402
from prompt_librarian.shared.errors import NotFoundError  # noqa: E402


def _png(path, size=(640, 320), color=(200, 40, 40), mode="RGB"):
    Image.new(mode, size, color).save(path)
    return str(path)


@pytest.fixture
def root(tmp_path):
    return str(tmp_path / "word-images")


def test_attach_stores_a_small_webp(tmp_path, root):
    result = word_images.attach_word_image(root, "  Red   Hair ", _png(tmp_path / "a.png"))
    assert result["word"] == "red hair"
    path = word_images.word_image_path(root, "RED hair")
    with Image.open(path) as thumb:
        assert thumb.format == "WEBP"
        assert max(thumb.size) == word_images.THUMB_SIZE
        assert thumb.size == (256, 128), "aspect ratio is kept"
    assert os.path.getsize(path) < 10_000


def test_transparency_survives(tmp_path, root):
    source = _png(tmp_path / "a.png", color=(0, 0, 0, 0), mode="RGBA")
    word_images.attach_word_image(root, "ghost", source)
    with Image.open(word_images.word_image_path(root, "ghost")) as thumb:
        assert thumb.mode == "RGBA"


def _rgb(path, xy=(0, 0)):
    with Image.open(path) as image:
        return image.convert("RGB").getpixel(xy)


def test_attaching_again_adds_a_picture_and_shows_a_mosaic(tmp_path, root):
    first = word_images.attach_word_image(root, "cat", _png(tmp_path / "a.png"))
    second = word_images.attach_word_image(
        root, "cat", _png(tmp_path / "b.png", color=(0, 0, 255)))
    assert second["version"] > first["version"]
    listed = word_images.list_word_images(root)["cat"]
    assert listed["version"] == second["version"]
    assert [p["id"] for p in listed["pictures"]] == [
        first["pictures"][0]["id"], second["pictures"][1]["id"]], "new pictures go last"
    shown = word_images.word_image_path(root, "cat")
    with Image.open(shown) as mosaic:
        assert mosaic.size == (word_images.MOSAIC_SIZE, word_images.MOSAIC_SIZE)
    left, right = _rgb(shown, (10, 128)), _rgb(shown, (246, 128))
    assert left[0] > left[2] and right[2] > right[0], "2x1: red left, blue right"
    one = word_images.word_image_path(root, "cat", listed["pictures"][1]["id"])
    assert _rgb(one)[2] > 200, "each picture stays loadable on its own"


@pytest.mark.parametrize(("count", "grid"), [
    (1, (1, 1)), (2, (2, 1)), (3, (2, 2)), (4, (2, 2)), (5, (3, 2)), (6, (3, 2)),
    (7, (3, 3)), (9, (3, 3))])
def test_layout_grows_with_the_count(count, grid):
    assert word_images.layout(count) == grid


def test_one_picture_many_words(tmp_path, root):
    got = word_images.attach_word_image(root, ["Cat", "fox", "cat", " "], _png(tmp_path / "a.png"))
    assert [w["word"] for w in got["words"]] == ["cat", "fox"]
    assert got["word"] == "cat"
    assert set(word_images.list_word_images(root)) == {"cat", "fox"}


def test_nine_pictures_at_most(tmp_path, root):
    source = _png(tmp_path / "a.png")
    for _ in range(word_images.MAX_PICTURES):
        word_images.attach_word_image(root, "cat", source)
    got = word_images.attach_word_image(root, ["cat", "dog"], source)
    assert got["skipped"] == ["cat"]
    assert [w["word"] for w in got["words"]] == ["dog"]
    with pytest.raises(ValueError, match="already 9 pictures: cat"):
        word_images.attach_word_image(root, "cat", source)
    assert len(word_images.list_word_images(root)["cat"]["pictures"]) == 9


def test_remove_one_picture_rebuilds_what_is_shown(tmp_path, root):
    word_images.attach_word_image(root, "cat", _png(tmp_path / "a.png"))
    word_images.attach_word_image(root, "cat", _png(tmp_path / "b.png", color=(0, 0, 255)))
    red_id, blue_id = (p["id"] for p in word_images.list_word_images(root)["cat"]["pictures"])
    assert word_images.remove_word_image(root, "cat", red_id) is True
    assert word_images.remove_word_image(root, "cat", red_id) is False
    listed = word_images.list_word_images(root)["cat"]
    assert [p["id"] for p in listed["pictures"]] == [blue_id]
    assert _rgb(word_images.word_image_path(root, "cat"))[2] > 200, "back to the single picture"
    assert word_images.remove_word_image(root, "cat", blue_id) is True
    assert word_images.list_word_images(root) == {}
    assert [n for n in os.listdir(root) if n.endswith(".webp")] == []


def test_order_rearranges_the_mosaic(tmp_path, root):
    word_images.attach_word_image(root, "cat", _png(tmp_path / "a.png"))
    word_images.attach_word_image(root, "cat", _png(tmp_path / "b.png", color=(0, 0, 255)))
    red_id, blue_id = (p["id"] for p in word_images.list_word_images(root)["cat"]["pictures"])
    got = word_images.order_word_images(root, "cat", [blue_id, "nope"])
    assert [p["id"] for p in got["pictures"]] == [blue_id, red_id], "unlisted ids keep their place"
    assert _rgb(word_images.word_image_path(root, "cat"), (10, 128))[2] > 200, "blue now left"
    with pytest.raises(NotFoundError):
        word_images.order_word_images(root, "dog", [])


def test_single_picture_entries_from_before_keep_working(tmp_path, root):
    from prompt_librarian.features.word_images import _index

    word_images.attach_word_image(root, "cat", _png(tmp_path / "a.png"))
    index = _index.read_index(root)
    for name in os.listdir(root):
        if "-" in name:
            os.unlink(os.path.join(root, name))
    index["cat"].pop("pics")
    _index.write_index(root, index)
    [legacy] = word_images.list_word_images(root)["cat"]["pictures"]
    assert legacy["id"] == "1"
    assert word_images.word_image_path(root, "cat", "1") == word_images.word_image_path(root, "cat")
    word_images.attach_word_image(root, "cat", _png(tmp_path / "b.png", color=(0, 0, 255)))
    ids = [p["id"] for p in word_images.list_word_images(root)["cat"]["pictures"]]
    assert ids[0] == "1" and len(ids) == 2
    assert _rgb(word_images.word_image_path(root, "cat", "1"))[0] > 150, "the old picture survives"


def test_remove_forgets_the_word(tmp_path, root):
    word_images.attach_word_image(root, "cat", _png(tmp_path / "a.png"))
    word_images.attach_word_image(root, "cat", _png(tmp_path / "b.png"))
    assert word_images.remove_word_image(root, " CAT ") is True
    assert word_images.remove_word_image(root, "cat") is False
    assert word_images.list_word_images(root) == {}
    assert word_images.word_image_path(root, "cat") is None
    assert [n for n in os.listdir(root) if n.endswith(".webp")] == []


def test_listing_skips_entries_whose_file_is_gone(tmp_path, root):
    word_images.attach_word_image(root, "cat", _png(tmp_path / "a.png"))
    os.unlink(word_images.word_image_path(root, "cat"))
    assert word_images.list_word_images(root) == {}


def test_empty_or_missing_directory_lists_nothing(root):
    assert word_images.list_word_images(root) == {}
    assert word_images.word_image_path(root, "cat") is None
    assert word_images.word_image_path(root, "   ") is None


def test_bad_input_is_rejected(tmp_path, root):
    with pytest.raises(ValueError, match="empty"):
        word_images.attach_word_image(root, "  ", _png(tmp_path / "a.png"))
    with pytest.raises(NotFoundError):
        word_images.attach_word_image(root, "cat", str(tmp_path / "nope.png"))
    junk = tmp_path / "junk.png"
    junk.write_bytes(b"not an image")
    with pytest.raises(ValueError, match="not a readable image"):
        word_images.attach_word_image(root, "cat", str(junk))
    assert word_images.list_word_images(root) == {}


def test_sources_stay_inside_their_comfyui_directory(tmp_path):
    out = tmp_path / "output"
    (out / "sub").mkdir(parents=True)
    roots = {"output": str(out)}
    resolved = word_images.resolve_source("x.png", "sub", "output", roots=roots)
    assert resolved == os.path.realpath(out / "sub" / "x.png")
    for filename, subfolder in (("../secret.png", ""), ("x.png", "../.."), ("/etc/passwd", "")):
        with pytest.raises(ValueError, match="leaves"):
            word_images.resolve_source(filename, subfolder, "output", roots=roots)
    with pytest.raises(ValueError, match="unknown image type"):
        word_images.resolve_source("x.png", "", "user", roots=roots)
    with pytest.raises(ValueError, match="empty"):
        word_images.resolve_source("", "", "output", roots=roots)
