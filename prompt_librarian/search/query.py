"""Parse tag operators, exclusions, phrases, and free-text terms."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .text import normalize, tokenize


@dataclass(slots=True)
class ParsedQuery:
    raw: str = ""
    text: str = ""  # residual free text
    qnorm: str = ""  # normalized residual
    tokens: tuple[str, ...] = ()
    phrases: tuple[str, ...] = ()  # normalized, substring-required
    excludes: tuple[str, ...] = ()  # normalized tokens
    tags: tuple[str, ...] = ()  # from tag:x

    def is_empty(self) -> bool:
        return not (self.tokens or self.phrases or self.excludes or self.tags)


_FIELD_OP_RE = re.compile(
    r"(?P<neg>-)?(?P<fieldk>tags?)\s*:\s*"
    r'(?:"(?P<quoted>[^"]*)"|(?P<bare>\S+))',
    re.IGNORECASE,
)
_PHRASE_RE = re.compile(r'"([^"]*)"')


def parse_query(q: Any) -> ParsedQuery:
    """Strip ``tag:``/``-word``/``"phrase"`` before tokenization."""
    raw = q if isinstance(q, str) else ("" if q is None else str(q))
    tags: list[str] = []
    excludes: list[str] = []
    phrases: list[str] = []

    def _take_field(m: re.Match) -> str:
        val = m.group("quoted")
        if val is None:
            val = m.group("bare") or ""
        norm = normalize(val)
        if norm:
            if m.group("neg"):
                # -tag:x behaves as a plain exclusion of that word
                excludes.extend(norm.split())
            else:
                tags.append(norm)
        return " "

    rest = _FIELD_OP_RE.sub(_take_field, raw)

    def _take_phrase(m: re.Match) -> str:
        norm = normalize(m.group(1))
        if norm:
            phrases.append(norm)
            return " " + norm + " "
        return " "

    rest = _PHRASE_RE.sub(_take_phrase, rest)

    keep: list[str] = []
    for word in rest.split():
        if word.startswith("-") and len(word) > 1:
            excludes.extend(tokenize(word[1:]))
        else:
            keep.append(word)

    text = " ".join(keep)
    qnorm = normalize(text)
    tokens = qnorm.split() if qnorm else []
    return ParsedQuery(
        raw=raw,
        text=text,
        qnorm=qnorm,
        tokens=tuple(tokens),
        phrases=tuple(phrases),
        excludes=tuple(dict.fromkeys(excludes)),
        tags=tuple(dict.fromkeys(tags)),
    )
