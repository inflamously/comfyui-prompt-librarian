"""Pictures for words, previewed beside autocomplete and in the gallery."""

from ._mosaic import MOSAIC_SIZE, layout
from ._pictures import MAX_PICTURES
from ._thumb import THUMB_SIZE
from .attach import attach_word_image
from .candidates import is_filler, picture_candidates
from .listing import list_word_images, word_image_entry
from .locate import word_image_path
from .order import order_word_images
from .remove import remove_word_image
from .sources import resolve_source

__all__ = [
    "MAX_PICTURES",
    "MOSAIC_SIZE",
    "THUMB_SIZE",
    "attach_word_image",
    "is_filler",
    "layout",
    "list_word_images",
    "order_word_images",
    "picture_candidates",
    "remove_word_image",
    "resolve_source",
    "word_image_entry",
    "word_image_path",
]
