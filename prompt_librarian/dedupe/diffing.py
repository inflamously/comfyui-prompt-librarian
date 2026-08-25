"""Word-level diff payloads and readable change summaries."""

from __future__ import annotations

import difflib
import re
import unicodedata
from collections.abc import Sequence
from typing import Any

from .core import ratio, sim_norm

DIFF_OPCODE_CAP = 2000
SUMMARY_MAX_CHANGES = 3
SUMMARY_MAX_TOKENS = 5

LQUO = "“"
RQUO = "”"
ARROW = "→"
ELLIPSIS = "…"

_WS_TOKEN_RE = re.compile(r"\S+")
_EDGE_PUNCT_RE = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)


def _tok_pairs(text: Any) -> tuple[list[str], list[str]]:
    """Return display tokens and punctuation-insensitive matching keys."""
    if not text:
        return [], []
    if not isinstance(text, str):
        text = str(text)
    display = _WS_TOKEN_RE.findall(text)
    keys: list[str] = []
    for token in display:
        key = unicodedata.normalize("NFKC", token).casefold()
        stripped = _EDGE_PUNCT_RE.sub("", key)
        keys.append(stripped if stripped else key)
    return display, keys


def diff_tokens(
    a: Any,
    b: Any,
    cap: int = DIFF_OPCODE_CAP,
) -> list[dict[str, Any]]:
    """Return capped, full word-level opcodes, including equal runs."""
    a_display, a_keys = _tok_pairs(a)
    b_display, b_keys = _tok_pairs(b)
    matcher = difflib.SequenceMatcher(None, a_keys, b_keys, autojunk=False)
    result: list[dict[str, Any]] = []
    for operation, i1, i2, j1, j2 in matcher.get_opcodes():
        result.append(
            {
                "op": operation,
                "a_start": i1,
                "a_end": i2,
                "b_start": j1,
                "b_end": j2,
                "a_tokens": a_display[i1:i2],
                "b_tokens": b_display[j1:j2],
            }
        )
        if len(result) >= cap:
            break
    return result


def _span(tokens: Sequence[str]) -> str:
    if len(tokens) > SUMMARY_MAX_TOKENS:
        return " ".join(tokens[:SUMMARY_MAX_TOKENS]) + ELLIPSIS
    return " ".join(tokens)


def diff_summary(a: Any, b: Any, max_changes: int = SUMMARY_MAX_CHANGES) -> str:
    """Summarize non-equal word-level diff operations for the UI."""
    changes: list[str] = []
    total = 0
    for chunk in diff_tokens(a, b):
        operation = chunk["op"]
        if operation == "equal":
            continue
        total += 1
        if len(changes) >= max_changes:
            continue
        if operation == "replace":
            changes.append(
                "{}{}{} {} {}{}{}".format(
                    LQUO,
                    _span(chunk["a_tokens"]),
                    RQUO,
                    ARROW,
                    LQUO,
                    _span(chunk["b_tokens"]),
                    RQUO,
                )
            )
        elif operation == "insert":
            changes.append("+ " + _span(chunk["b_tokens"]))
        elif operation == "delete":
            changes.append("- " + _span(chunk["a_tokens"]))
    if not changes:
        return ""
    result = ", ".join(changes)
    extra = total - len(changes)
    if extra > 0:
        result += f", +{extra} more"
    return result


def compare(
    a_text: Any,
    b_text: Any,
    max_changes: int = SUMMARY_MAX_CHANGES,
) -> dict[str, Any]:
    """Build the score and word diff used by the compare/merge dialog."""
    score = ratio(sim_norm(a_text), sim_norm(b_text), 0.0)
    return {
        "score": round(score, 6),
        "pct": int(round(score * 100)),
        "summary": diff_summary(a_text, b_text, max_changes=max_changes),
        "diff": diff_tokens(a_text, b_text),
    }
