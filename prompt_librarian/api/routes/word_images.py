"""Word pictures. The thumbnail itself is a file response, not JSON."""

from ... import app
from ...features import word_images
from ...shared.errors import NotFoundError
from .. import schemas
from ..utils import _body, _get_web, _int, _json, _offload, _query, _route, _str

_IMMUTABLE = "public, max-age=31536000, immutable"


def _root():
    return app.word_images_dir(app.current())


@_route("get", "/word_images", op="listWordImages",
        summary="Every word that has a picture, with its version.",
        returns=schemas.WordImagesResponse)
async def word_images_route(request):
    return _json({"images": await _offload(word_images.list_word_images, _root())})


@_route("get", "/word_images/candidates", op="wordPictureCandidates",
        summary="Words worth a generated picture: used, not filler, none yet.",
        query=schemas.WordCandidatesQuery, returns=schemas.WordCandidatesResponse)
async def word_picture_candidates_route(request):
    limit = max(1, min(5000, _int(_query(request).get("limit"), 500)))
    words, total = await _offload(app.word_picture_candidates, app.current(), limit)
    return _json({"words": words, "total": total})


@_route("get", "/word_image", op="getWordImage",
        summary="One word's WebP thumbnail.",
        query=schemas.WordImageQuery, returns=schemas.WordImageResponse)
async def word_image_route(request):
    params = _query(request)
    path = word_images.word_image_path(_root(), _str(params.get("word")), _str(params.get("id")))
    if path is None:
        raise NotFoundError("no picture for that word")
    cache = _IMMUTABLE if params.get("v") else "no-cache"
    return _get_web().FileResponse(
        path, headers={"Content-Type": "image/webp", "Cache-Control": cache})


@_route("post", "/word_image/attach", op="attachWordImage",
        summary="Add an image ComfyUI produced (generated or picked) to one or more words.",
        body=schemas.AttachWordImageBody, returns=schemas.AttachWordImageResponse)
async def attach_word_image_route(request):
    data = await _body(request)
    source = word_images.resolve_source(
        _str(data.get("filename")), _str(data.get("subfolder")), _str(data.get("type"), "output"))
    kind = "generated" if _str(data.get("source")) == "generated" else "manual"
    words = data.get("words") if isinstance(data.get("words"), list) else []
    words = [_str(w) for w in words] or [_str(data.get("word"))]
    return _json(await _offload(word_images.attach_word_image, _root(), words, source, kind))


@_route("post", "/word_image/remove", op="removeWordImage",
        body=schemas.RemoveWordImageBody, returns=schemas.RemoveWordImageResponse)
async def remove_word_image_route(request):
    """Forget a word's pictures, or the one named by `id`."""
    data = await _body(request)
    word = _str(data.get("word"))
    removed = await _offload(word_images.remove_word_image, _root(), word, _str(data.get("id")))
    images = await _offload(word_images.list_word_images, _root())
    return _json({"word": word, "removed": removed,
                  "image": images.get(" ".join(word.split()).lower())})


@_route("post", "/word_image/order", op="orderWordImages",
        summary="Rearrange a word's pictures; the mosaic follows the new order.",
        body=schemas.OrderWordImagesBody, returns=schemas.OrderWordImagesResponse)
async def order_word_images_route(request):
    data = await _body(request)
    ids = data.get("ids") if isinstance(data.get("ids"), list) else []
    return _json(await _offload(
        word_images.order_word_images, _root(), _str(data.get("word")), [_str(i) for i in ids]))
