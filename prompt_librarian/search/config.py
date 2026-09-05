"""Search weights, matching limits, and result defaults."""

from __future__ import annotations

# The name field used to carry a weight of its own (3.0, plus an exact-match
# bonus), and it was the field a user searched when they knew what they were
# looking for.  With it gone, the *head* of the body inherits that role: a
# prompt says what it is about in its first line and qualifies it afterwards,
# so an early match is a stronger signal than a late one.  It is a bonus on
# top of W_BODY, not a replacement for it -- a head token scores both.
W_HEAD = 1.5
W_TAG = 2.0
W_BODY = 1.0

HEAD_TOKENS = 12

PHRASE_HEAD = 1.0
PHRASE_BODY = 1.0
POP_BONUS = 0.15
REC_BONUS = 0.10

TIER_EXACT = 1.0
TIER_PREFIX = 0.85
TIER_INFIX = 0.60
TIER_EDIT1 = 0.50

EDIT1_MIN_LEN = 4
PREFIX_EXPAND_CAP = 200
FALLBACK_TERM_CAP = 200
PREVIEW_CHARS = 160
SORT_KEY_CHARS = 120  # of the body, per doc, kept only to sort "az" by

SORTS = ("relevance", "recent", "most_used", "az")
MODES = ("all", "any")

#: Members shipped with one collapsed cluster. `group_size` reports the real
#: size regardless, so a truncated group is visible rather than silent.
GROUP_MEMBER_CAP = 50
