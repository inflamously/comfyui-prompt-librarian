"""Shrink any image (a path or downloaded bytes) to the stored WebP thumbnail."""

import io

#: Longest side of a stored thumbnail, in pixels: sharp as a 128 px preview on
#: high-DPI screens, and big enough for a mosaic cell.
THUMB_SIZE = 256
#: WebP quality; ~10 KB per thumbnail at 256 px.
QUALITY = 80


def make_thumbnail(source: str | bytes, name: str = "image") -> bytes:
    """WebP bytes at most ``THUMB_SIZE`` on the longest side, alpha kept.

    Raises:
        ValueError: Pillow is missing, or ``source`` is not a readable image.
    """
    try:
        from PIL import Image, ImageOps  # noqa: PLC0415 - ships with ComfyUI, optional headless
    except ImportError as exc:
        raise ValueError("Pillow is not installed; word pictures need it") from exc
    handle = io.BytesIO(source) if isinstance(source, bytes) else source
    try:
        with Image.open(handle) as image:
            image.draft("RGB", (THUMB_SIZE * 2, THUMB_SIZE * 2))  # cheap JPEG downscale
            image = ImageOps.exif_transpose(image)
            image.thumbnail((THUMB_SIZE, THUMB_SIZE))
            has_alpha = image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info
            image = image.convert("RGBA" if has_alpha else "RGB")
            out = io.BytesIO()
            image.save(out, "WEBP", quality=QUALITY, method=4)
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ValueError(f"not a readable image: {name}") from exc
    return out.getvalue()
