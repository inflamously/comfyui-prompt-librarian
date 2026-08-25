"""Core text normalization and similarity primitives."""

from __future__ import annotations

import difflib
from typing import Any

from ..search import normalize

SIM_MAX_CHARS = 4000
DEFAULT_THRESHOLD = 0.90


def sim_norm(body: Any) -> str:
    """Return a normalized, bounded comparison form of a prompt body."""
    return normalize(body)[:SIM_MAX_CHARS]


def ratio(a: str, b: str, t: float = 0.0) -> float:
    """Return the similarity of ``a`` and ``b``, or zero below ``t``.

    ``autojunk=False`` is mandatory for prose-like prompt text: the default
    heuristic treats common letters and spaces as junk in longer strings.
    """
    if not a or not b:
        return 1.0 if (a == b and t <= 1.0) else 0.0
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    if t > 0.0:
        if sm.real_quick_ratio() < t:
            return 0.0
        if sm.quick_ratio() < t:
            return 0.0
    result = sm.ratio()
    if t > 0.0 and result < t:
        return 0.0
    return result


def length_ok(la: int, lb: int, t: float) -> bool:
    """Apply the ratio upper bound derived from the two text lengths."""
    if la <= 0 or lb <= 0:
        return la == lb
    return 2 * min(la, lb) >= t * (la + lb)
