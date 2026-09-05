"""Lay several pictures out as one square image: 1x1, 2x1, 2x2, 3x2 or 3x3."""

import io

#: Side of the composed square, in pixels; each cell is cropped to fill its slot.
MOSAIC_SIZE = 256
QUALITY = 80


def layout(count: int) -> tuple[int, int]:
    """``(columns, rows)`` for ``count`` pictures: the smallest grid that holds them."""
    if count <= 1:
        return 1, 1
    if count == 2:
        return 2, 1
    if count <= 4:
        return 2, 2
    if count <= 6:
        return 3, 2
    return 3, 3


def compose(images: list[bytes]) -> bytes:
    """One WebP of ``images`` in reading order, each center-cropped to its cell.

    Raises:
        ValueError: Pillow is missing, or one of the images is unreadable.
    """
    try:
        from PIL import Image, ImageOps  # noqa: PLC0415 - ships with ComfyUI, optional headless
    except ImportError as exc:
        raise ValueError("Pillow is not installed; word pictures need it") from exc
    columns, rows = layout(len(images))
    canvas = Image.new("RGBA", (MOSAIC_SIZE, MOSAIC_SIZE), (0, 0, 0, 0))
    for i, data in enumerate(images[: columns * rows]):
        left, top = _edge(i % columns, columns), _edge(i // columns, rows)
        right, bottom = _edge(i % columns + 1, columns), _edge(i // columns + 1, rows)
        try:
            with Image.open(io.BytesIO(data)) as image:
                cell = ImageOps.fit(image.convert("RGBA"), (right - left, bottom - top))
        except OSError as exc:
            raise ValueError("a stored picture is not readable") from exc
        canvas.paste(cell, (left, top))
    out = io.BytesIO()
    canvas.save(out, "WEBP", quality=QUALITY, method=4)
    return out.getvalue()


def _edge(index: int, count: int) -> int:
    return round(index * MOSAIC_SIZE / count)
