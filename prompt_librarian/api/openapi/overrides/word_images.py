"""word_images: the thumbnail itself, served as WebP rather than JSON."""


def _word_image_ok(components):
    return {
        "description": "The word's WebP thumbnail; immutable when `v` is given.",
        "content": {"image/webp": {"schema": {"type": "string", "format": "binary"}}},
    }


SUCCESS = {"getWordImage": _word_image_ok}
