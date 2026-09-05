"""Plain definitions for prompt words, from WordNet, downloaded once.

``install`` fetches Princeton WordNet 3.0 (about 11 MB) and converts it into
``wordnet.sqlite3`` inside ``root``, a directory beside the library chosen by
the composition root. After that every lookup and search is local. Nothing
here touches the library's own database.
"""

from .install import install
from .lookup import define
from .search import search_words
from .status import dictionary_status

__all__ = ["define", "dictionary_status", "install", "search_words"]
