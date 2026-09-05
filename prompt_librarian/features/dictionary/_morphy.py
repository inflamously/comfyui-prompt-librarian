"""Find the base form WordNet files a word under: "forests" -> "forest"."""

#: WordNet's own detachment rules (morph.c), per part of speech.
_SUFFIXES = {
    "noun": (("s", ""), ("ses", "s"), ("xes", "x"), ("zes", "z"), ("ches", "ch"),
             ("shes", "sh"), ("men", "man"), ("ies", "y")),
    "verb": (("s", ""), ("ies", "y"), ("es", "e"), ("es", ""), ("ed", "e"), ("ed", ""),
             ("ing", "e"), ("ing", "")),
    "adjective": (("er", ""), ("est", ""), ("er", "e"), ("est", "e")),
}


def candidates(word: str) -> list[str]:
    """The word itself, then every base form the suffix rules allow, without repeats."""
    out = [word]
    for rules in _SUFFIXES.values():
        for suffix, ending in rules:
            if word.endswith(suffix) and len(word) > len(suffix) + 1:
                out.append(word[: -len(suffix)] + ending)
    return list(dict.fromkeys(out))
