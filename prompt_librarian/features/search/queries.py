"""Search's SQL: candidate records for a query, and corpus statistics for scoring.

The scorer still runs in Python over the candidates, so ordering and filters stay
one implementation instead of drifting into SQL-specific behaviour.
"""

import sqlite3
from typing import Any

from ...shared import corpus
from ...shared.text import normalize, within_edit_1
from .config import EDIT1_MIN_LEN, FALLBACK_TERM_CAP, PREFIX_EXPAND_CAP


def candidate_records(
    con: sqlite3.Connection, tokens: list[str], mode: str, fts5: bool
) -> list[dict[str, Any]]:
    """Records whose postings match ``tokens`` by exact/prefix, else by infix/edit-1.

    ``mode`` is ``"all"`` (every token) or ``"any"``. No tokens means every record.
    """
    tokens = [token for token in (normalize(t) for t in tokens) if token]
    if not tokens:
        return corpus.all_records(con)
    ids = _prefix_ids(con, tokens, mode, fts5) or _fallback_ids(con, tokens)
    return corpus.records_by_id(con, ids)


def _prefix_ids(con: sqlite3.Connection, tokens: list[str], mode: str, fts5: bool) -> set[str]:
    if fts5:
        joiner = " AND " if mode == "all" else " OR "
        expression = joiner.join(f'"{token}"*' for token in tokens)
        try:
            rows = con.execute("SELECT id FROM prompt_fts WHERE prompt_fts MATCH ?", (expression,))
            return {row[0] for row in rows}
        except sqlite3.OperationalError:
            pass  # a damaged FTS table; the postings answer the same question
    per_token = [_ids_for_terms(con, _prefix_terms(con, token)) for token in tokens]
    return set.intersection(*per_token) if mode == "all" else set().union(*per_token)


def _prefix_terms(con: sqlite3.Connection, token: str) -> list[str]:
    rows = con.execute(
        "SELECT DISTINCT term FROM terms WHERE term LIKE ? ORDER BY term LIMIT ?",
        (token + "%", PREFIX_EXPAND_CAP),
    )
    return [row[0] for row in rows]


def _fallback_ids(con: sqlite3.Connection, tokens: list[str]) -> set[str]:
    """The capped infix/edit-1 vocabulary fallback the in-memory search also uses."""
    vocab = [row[0] for row in con.execute("SELECT DISTINCT term FROM terms ORDER BY term")]
    found: list[str] = []
    for token in tokens:
        found += [term for term in vocab if _near(token, term)]
        if len(found) >= FALLBACK_TERM_CAP:
            break
    return _ids_for_terms(con, found[:FALLBACK_TERM_CAP])


def _near(token: str, term: str) -> bool:
    return token in term or (len(token) >= EDIT1_MIN_LEN and within_edit_1(token, term))


def _ids_for_terms(con: sqlite3.Connection, terms: list[str]) -> set[str]:
    if not terms:
        return set()
    marks = ",".join("?" for _ in terms)
    rows = con.execute(f"SELECT DISTINCT prompt_id FROM terms WHERE term IN ({marks})", terms)
    return {row[0] for row in rows}


def corpus_stats(con: sqlite3.Connection) -> dict[str, Any]:
    """Record count, the highest usage, and every ``updated`` stamp in order."""
    count, max_used = con.execute("SELECT COUNT(*), COALESCE(MAX(used),0) FROM entries").fetchone()
    updated = [row[0] for row in con.execute("SELECT updated FROM entries ORDER BY updated")]
    return {"count": count, "max_used": max_used, "updated": updated}


def term_df(con: sqlite3.Connection, token: str) -> int:
    """How many records contain the normalized ``token``."""
    return con.execute("SELECT COUNT(*) FROM terms WHERE term=?", (normalize(token),)).fetchone()[0]
