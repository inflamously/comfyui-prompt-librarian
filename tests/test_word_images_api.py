"""The word-picture routes, driven directly like ``tests/test_api.py``."""

import asyncio
import json
import os

import pytest

pytest.importorskip("aiohttp")
Image = pytest.importorskip("PIL.Image")

from prompt_librarian import api  # noqa: E402
from prompt_librarian import app as librarian_app  # noqa: E402
from prompt_librarian.features.word_images import sources  # noqa: E402
from tests.test_api import FakeRoutes, Request  # noqa: E402


@pytest.fixture
def routes():
    table = FakeRoutes()
    api.register(table)
    return table.table


@pytest.fixture
def output(tmp_path, monkeypatch):
    """A synthetic ComfyUI output directory holding one image."""
    out = tmp_path / "output"
    out.mkdir()
    Image.new("RGB", (300, 300), (10, 200, 10)).save(out / "gen_00001_.png")
    monkeypatch.setattr(sources, "comfy_roots", lambda: {"output": str(out)})
    return out


@pytest.fixture
def store(tmp_path):
    target = librarian_app.build(path=str(tmp_path / "lib" / "library.sqlite3"),
                                 migrate_from=False)
    librarian_app.use(target)
    yield target
    target.lib.close()


def _call(routes, method, path, query=None, body=None):
    return asyncio.run(routes[(method, api.PREFIX + path)](Request(query, body)))


def _json(response):
    return response.status, json.loads(response.body.decode("utf-8"))


def test_attach_list_fetch_remove(routes, store, output):
    status, attached = _json(_call(routes, "post", "/word_image/attach", body={
        "word": "Forest", "filename": "gen_00001_.png", "subfolder": "", "type": "output"}))
    assert status == 200, attached
    assert attached["word"] == "forest"
    folder = os.path.join(os.path.dirname(store.lib.path), "word-images")
    assert os.path.isdir(folder), "pictures live beside the library"

    _status, listed = _json(_call(routes, "get", "/word_images"))
    assert listed["images"] == {"forest": {
        "version": attached["version"], "source": "manual", "page": "",
        "pictures": attached["pictures"]}}

    image = _call(routes, "get", "/word_image",
                  query={"word": "forest", "v": attached["version"]})
    assert image.status == 200
    assert "immutable" in image.headers["Cache-Control"]
    assert image.headers["Content-Type"] == "image/webp"
    unversioned = _call(routes, "get", "/word_image", query={"word": "forest"})
    assert unversioned.headers["Cache-Control"] == "no-cache"

    _status, removed = _json(_call(routes, "post", "/word_image/remove", body={"word": "forest"}))
    assert removed["removed"] is True
    status, missing = _json(_call(routes, "get", "/word_image", query={"word": "forest"}))
    assert (status, missing["code"]) == (404, "not_found")


def test_several_words_one_picture_then_arrange(routes, store, output):
    status, attached = _json(_call(routes, "post", "/word_image/attach", body={
        "words": ["Forest", "green"], "filename": "gen_00001_.png"}))
    assert status == 200, attached
    assert [w["word"] for w in attached["words"]] == ["forest", "green"]
    _call(routes, "post", "/word_image/attach",
          body={"word": "forest", "filename": "gen_00001_.png"})
    _status, listed = _json(_call(routes, "get", "/word_images"))
    first, second = (p["id"] for p in listed["images"]["forest"]["pictures"])

    image = _call(routes, "get", "/word_image", query={"word": "forest", "id": second})
    assert image.status == 200
    status, ordered = _json(_call(routes, "post", "/word_image/order", body={
        "word": "forest", "ids": [second, first]}))
    assert status == 200, ordered
    assert [p["id"] for p in ordered["pictures"]] == [second, first]

    _status, removed = _json(_call(routes, "post", "/word_image/remove", body={
        "word": "forest", "id": second}))
    assert removed["removed"] is True
    assert [p["id"] for p in removed["image"]["pictures"]] == [first]
    _status, gone = _json(_call(routes, "post", "/word_image/remove", body={
        "word": "forest", "id": first}))
    assert gone["image"] is None


def test_attach_rejects_paths_outside_the_output_directory(routes, store, output):
    status, payload = _json(_call(routes, "post", "/word_image/attach", body={
        "word": "x", "filename": "../library.sqlite3", "type": "output"}))
    assert (status, payload["code"]) == (400, "bad_request")
    status, payload = _json(_call(routes, "post", "/word_image/attach", body={
        "word": "x", "filename": "missing.png", "type": "output"}))
    assert (status, payload["code"]) == (404, "not_found")


def test_candidates_skip_filler_and_pictured_words(routes, store, output):
    from tests import uc

    uc.create_prompt(store.lib, body="masterpiece, best quality, red fox, a cathedral", tags=[])
    uc.create_prompt(store.lib, body="red fox, 8k, snowy forest", tags=[])
    _call(routes, "post", "/word_image/attach", body={
        "word": "cathedral", "filename": "gen_00001_.png", "source": "generated"})
    _status, listed = _json(_call(routes, "get", "/word_images"))
    assert listed["images"]["cathedral"]["source"] == "generated"

    _status, got = _json(_call(routes, "get", "/word_images/candidates"))
    assert {w.lower() for w in got["words"][:3]} == {"red", "fox", "red fox"}, "most used first"
    assert "cathedral" not in got["words"], "already has a picture"
    lowered = {w.lower() for w in got["words"]}
    assert not lowered & {"masterpiece", "best quality", "8k", "a", "best", "quality"}
    assert {"red", "fox", "snowy forest"} <= lowered
    _status, one = _json(_call(routes, "get", "/word_images/candidates", query={"limit": 1}))
    assert (len(one["words"]), one["total"]) == (1, got["total"])
