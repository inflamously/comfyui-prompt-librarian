"""Weighted choice and distinct pick-N selection for brace expressions."""

from .syntax import _PICK_RE, _WEIGHT_RE


def _split_options(inner):
    """Split a brace body on real pipes (escaped ones are already sentinels)."""
    return inner.split("|")


def _weigh(option):
    """``("text", weight)`` for one option, honouring a ``N::`` prefix."""
    match = _WEIGHT_RE.match(option)
    if match:
        try:
            weight = float(match.group(1))
        except ValueError:
            weight = 1.0
        return match.group(2), max(0.0, weight)
    return option, 1.0


def _weighted_pick(rng, entries):
    """Pick one ``(text, weight)`` entry. Falls back to uniform when all weigh 0."""
    total = sum(weight for _, weight in entries)
    if total <= 0.0:
        return entries[rng.randrange(len(entries))][0]
    target = rng.random() * total
    upto = 0.0
    for text, weight in entries:
        upto += weight
        if target < upto:
            return text
    return entries[-1][0]


def _pick_n(rng, entries, count):
    """Pick ``count`` *distinct* entries, weighted, in selection order."""
    pool = list(entries)
    count = max(0, min(count, len(pool)))
    chosen = []
    for _ in range(count):
        text = _weighted_pick(rng, pool)
        chosen.append(text)
        for index, (candidate, _weight) in enumerate(pool):
            if candidate == text:
                pool.pop(index)
                break
        if not pool:
            break
    return chosen


def _resolve_brace(inner, rng):
    """Resolve one innermost brace body to its replacement text."""
    pick_match = _PICK_RE.match(inner)
    low = high = None
    if pick_match:
        low = int(pick_match.group(1))
        high = int(pick_match.group(2)) if pick_match.group(2) is not None else low
        inner = pick_match.group(3)
        if high < low:
            low, high = high, low

    entries = [_weigh(part) for part in _split_options(inner)]
    if not entries:
        return ""

    if low is None:
        return _weighted_pick(rng, entries)

    count = low if high == low else rng.randint(low, high)
    return ", ".join(_pick_n(rng, entries, count))
