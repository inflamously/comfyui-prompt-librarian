"""Plain WordNet definitions for prompt words, downloaded once and looked up locally."""

from .install import install
from .lookup import define
from .search import search_words
from .status import dictionary_status

__all__ = ["define", "dictionary_status", "install", "search_words"]
