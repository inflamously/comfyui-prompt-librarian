"""Which words deserve a generated picture: used, not filler, none yet."""

import re
from collections.abc import Iterable

from ...shared.labels import STOPWORDS
from . import _index

# Prompt boilerplate that says nothing a picture could show. Function words come
# from the shared STOPWORDS; these are the image-prompt equivalents.
_FILLER_TEXT = """
masterpiece best quality high quality highest quality top quality good quality
normal quality low quality worst quality bad quality amazing quality
highres absurdres lowres incredibly absurdres hires ultra detailed highly detailed
extremely detailed very detailed detailed intricate details intricate
8k 4k 2k hd uhd hdr raw photo sharp focus official art
score_9 score_8_up score_7_up score_6_up score_5_up score_4_up
safe sfw nsfw rating general sensitive questionable explicit
newest recent mid old oldest year
very aesthetic aesthetic displeasing very displeasing
bad anatomy bad hands extra fingers missing fingers watermark signature text
jpeg artifacts blurry cropped username error
"""
_FILLER_PHRASES = frozenset(
    line.strip() for line in """
best quality
high quality
highest quality
top quality
good quality
normal quality
low quality
worst quality
bad quality
amazing quality
ultra detailed
highly detailed
extremely detailed
very detailed
intricate details
incredibly absurdres
raw photo
sharp focus
official art
very aesthetic
very displeasing
bad anatomy
bad hands
extra fingers
missing fingers
jpeg artifacts
""".strip().splitlines()
)
FILLER = frozenset(_FILLER_TEXT.split()) | _FILLER_PHRASES | STOPWORDS

MIN_CHARS = 3
_NOT_A_THING = re.compile(r"^[\d\W_]+$")  # numbers, weights, punctuation


def is_filler(word: str) -> bool:
    """True for words a picture cannot show: function words, quality tags, numbers."""
    key = _index.normalize(word)
    if len(key.replace(" ", "")) < MIN_CHARS or _NOT_A_THING.match(key):
        return True
    if key in FILLER:
        return True
    return all(part in FILLER for part in key.split())


def picture_candidates(
    root: str, keywords: Iterable[tuple[str, int]], limit: int = 500
) -> tuple[list[str], int]:
    """The words to generate pictures for, most used first.

    Args:
        root: The word-images directory; words with a picture, or whose
            picture the user removed, are skipped.
        keywords: ``(spelling, use count)`` pairs, most used first.
        limit: How many words to return.

    Returns:
        ``(words, total)``: up to ``limit`` words, and how many qualified in all.
    """
    taken = set(_index.read_index(root)) | set(_index.read_misses(root))
    words, seen = [], set()
    for text, _count in keywords:
        key = _index.normalize(text)
        if key in taken or key in seen or is_filler(key):
            continue
        seen.add(key)
        words.append(text.strip())
    return words[:limit], len(words)
