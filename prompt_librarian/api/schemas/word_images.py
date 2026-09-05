"""Pictures for words, generated or attached by hand, previewed beside autocomplete."""

from dataclasses import dataclass

from .base import Envelope, _Schema


@dataclass
class PictureRef(_Schema):
    """One of a word's pictures."""

    id: str
    """Pass as `id` to `/word_image` to load just this picture."""
    version: int
    source: str

@dataclass
class WordPicture(_Schema):
    """What a word shows: one picture, or a mosaic of up to nine."""

    version: int
    """Changes whenever the shown image does; pass it as `v` to cache the image."""
    source: str
    """Where the first picture came from: `generated` or `manual`."""
    page: str
    """Reserved for pictures with a web origin; always empty today."""
    pictures: list[PictureRef]
    """In order; the shown image lays them out 1x1, 2x1, 2x2, 3x2 or 3x3."""

@dataclass
class WordImagesResponse(Envelope):
    images: dict[str, WordPicture]

@dataclass
class WordImageQuery(_Schema):
    word: str
    v: int | None = None
    """The version from the listing; with it the response is cached as immutable."""
    id: str = ""
    """One picture's id; without it the shown image (single picture or mosaic)."""

@dataclass
class WordImageResponse(Envelope):
    """Stands in for the WebP body, which the spec documents separately."""

@dataclass
class WordCandidatesQuery(_Schema):
    limit: int = 500
    """Clamped to 1–5000."""

@dataclass
class WordCandidatesResponse(Envelope):
    words: list[str]
    """Most used first, as spelled in saved prompts."""
    total: int
    """All candidates, before ``limit``."""

@dataclass
class AttachWordImageBody(_Schema):
    """An image ComfyUI already produced, as its `/view` URL names it."""

    word: str = ""
    """One word; ignored when `words` is given."""
    filename: str = ""
    words: list[str] | None = None
    """Several words that all get this picture."""
    subfolder: str = ""
    type: str = "output"
    """`output`, `input` or `temp`."""
    source: str = "manual"
    """`generated` when the batch generator made it, else `manual`."""

@dataclass
class WordPictureEntry(WordPicture):
    word: str

@dataclass
class AttachWordImageResponse(Envelope):
    """The first word's entry; `words` and `skipped` cover the rest."""

    word: str
    version: int
    source: str
    page: str
    pictures: list[PictureRef]
    words: list[WordPictureEntry]
    skipped: list[str]
    """Words that already had nine pictures."""

@dataclass
class RemoveWordImageBody(_Schema):
    word: str
    id: str = ""
    """One picture's id; without it every picture of the word goes."""

@dataclass
class RemoveWordImageResponse(Envelope):
    word: str
    removed: bool
    image: WordPicture | None
    """What the word shows now; null when it has no pictures left."""

@dataclass
class OrderWordImagesBody(_Schema):
    word: str
    ids: list[str]
    """Picture ids in the new order."""

@dataclass
class OrderWordImagesResponse(Envelope):
    word: str
    version: int
    source: str
    page: str
    pictures: list[PictureRef]
