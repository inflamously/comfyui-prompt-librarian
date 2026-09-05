"""The word gallery and its dictionary (WordNet, downloaded once on request)."""

import sqlite3

from ... import app
from ...features import dictionary
from .. import schemas
from ..utils import _int, _json, _offload, _query, _route, _str


def _root():
    return app.dictionary_dir(app.current())


@_route("get", "/gallery", op="gallery",
        summary="Every vocabulary word, most used first, with its picture if any.",
        query=schemas.GalleryQuery, returns=schemas.GalleryResponse)
async def gallery_route(request):
    limit = max(1, min(10000, _int(_query(request).get("limit"), 2000)))
    words, total = await _offload(app.gallery_words, app.current(), limit)
    return _json({"words": words, "total": total})


@_route("get", "/dictionary", op="define",
        summary="A word's plain definitions, examples, synonyms and antonyms.",
        query=schemas.DictionaryQuery, returns=schemas.DictionaryResponse)
async def dictionary_route(request):
    word = _str(_query(request).get("word"))
    return _json(await _offload(dictionary.define, _root(), word))


@_route("get", "/dictionary/search", op="searchDictionary",
        summary="Dictionary words that start with a prefix, common ones first.",
        query=schemas.DictionarySearchQuery, returns=schemas.DictionarySearchResponse)
async def dictionary_search_route(request):
    params = _query(request)
    limit = max(1, min(100, _int(params.get("limit"), 20)))
    return _json(await _offload(dictionary.search_words, _root(), _str(params.get("q")), limit))


@_route("post", "/dictionary/install", op="installDictionary",
        summary="Download WordNet (about 11 MB) once and convert it for offline lookups.",
        body=schemas.InstallDictionaryBody, returns=schemas.InstallDictionaryResponse)
async def dictionary_install_route(request):
    try:
        status = await _offload(dictionary.install, _root())
    except (OSError, ValueError, sqlite3.Error) as exc:  # offline, not WordNet, disk
        return _json({**dictionary.dictionary_status(_root()), "error": str(exc)})
    return _json({**status, "error": ""})
