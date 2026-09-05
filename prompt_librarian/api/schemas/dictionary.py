"""The word gallery and its plain-language dictionary."""

from dataclasses import dataclass

from .base import Envelope, _Schema
from .word_images import WordPicture


@dataclass
class GalleryQuery(_Schema):
    limit: int = 2000
    """Clamped to 1–10000."""

@dataclass
class GalleryWord(_Schema):
    word: str
    """As spelled in saved prompts."""
    uses: int
    """How many prompts use it."""
    picture: WordPicture | None = None

@dataclass
class GalleryResponse(Envelope):
    words: list[GalleryWord]
    """Most used first."""
    total: int
    """All words, before ``limit``."""

@dataclass
class DictionaryQuery(_Schema):
    word: str

@dataclass
class Meaning(_Schema):
    """One part of speech: a few short definitions and related words."""

    part: str
    definitions: list[str]
    examples: list[str]
    """One example phrase per definition; empty when WordNet has none."""
    synonyms: list[str]
    antonyms: list[str]

@dataclass
class DictionaryResponse(Envelope):
    word: str
    status: str
    """`found`, `missing`, or `not_installed` until the dictionary is downloaded."""
    lemma: str
    """The base form that was found: `forests` -> `forest`."""
    meanings: list[Meaning]
    parts: list[str]
    """For a missing phrase, the words in it that do have an entry."""
    source: str

@dataclass
class DictionarySearchQuery(_Schema):
    q: str
    limit: int = 20
    """Clamped to 1–100."""

@dataclass
class DictionarySearchResponse(Envelope):
    installed: bool
    words: list[str]
    """Exact match first, then words with more senses (the common ones)."""

@dataclass
class InstallDictionaryBody(_Schema):
    source: str = "wordnet"
    """The only source today: Princeton WordNet 3.0."""

@dataclass
class InstallDictionaryResponse(Envelope):
    installed: bool
    words: int
    source: str
    error: str
    """Why the download failed; empty on success."""
