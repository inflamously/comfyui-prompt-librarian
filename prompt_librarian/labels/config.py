"""Product-level tuning for derived labels."""

# Eight terms gives a scannable five-to-ten-word handle after adjacent picks
# merge into phrases.  The character cap keeps that handle to one line.
LABEL_TERMS = 8
LABEL_CHARS = 96
LABEL_SEP = " · "
MIN_TERM_CHARS = 3
HEAD_CHARS = 96
ELLIPSIS = "…"

# A search page labels many records, so do not scan an entire maximum-size
# prompt to find the handful of words used by a label.
LABEL_SCAN_CHARS = 4000

# Function words only.  Domain-specific words are deliberately left to idf:
# whether "photo" is useful depends on the library around the prompt.
_STOPWORD_TEXT = """
a about after again against all along already also although always among an
and another any anything are around as at be because been before being both
but by can come comes could did do does doing done down during each either
else even ever every few for from get gets got had has have he her hers him
his how however i if in into is it its just like made make makes many may me
might more most much must my near neither never next no nor not now of off on
once one only onto or other others our ours out over own per put said same see
seen she should since so some still such take takes than that the their theirs
them then there therefore these they this those though through throughout thus
to together too toward towards until up upon us very via want was way we well
were what when whenever where whether which while who whom why will with
within without would yet you your yours
"""
STOPWORDS = frozenset(_STOPWORD_TEXT.split())

__all__ = [
    "ELLIPSIS",
    "HEAD_CHARS",
    "LABEL_CHARS",
    "LABEL_SCAN_CHARS",
    "LABEL_SEP",
    "LABEL_TERMS",
    "MIN_TERM_CHARS",
    "STOPWORDS",
]
