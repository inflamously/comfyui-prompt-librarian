"""Dupes' SQL: records that could clear a similarity threshold for a probe text.

A disk-backed equivalent of ``DupeIndex.candidates``: rare shared tokens, plus
records of similar token count for short probes, then the length bound and the
token-overlap bound. Scoring still happens in :mod:`.core`.
"""

import sqlite3
from typing import Any

from ...shared import corpus
from ...shared.text import normalize

RARE_TOKENS = 8
DF_FLOOR = 50
DF_SHARE = 0.15
SHORT_PROBE_TOKENS = 4


def candidate_records(
    con: sqlite3.Connection, text: str, threshold: float, exclude: tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    """Projected records that may be within ``threshold`` of ``text``."""
    probe = normalize(text)[: corpus.SIM_MAX_CHARS]
    if not probe:
        return []
    tokens = set(probe.split())
    ids = _rare_token_ids(con, tokens)
    if len(tokens) < SHORT_PROBE_TOKENS or not ids:
        ids |= _similar_size_ids(con, len(tokens))
    ids -= {str(pid) for pid in exclude if pid}
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    rows = con.execute(
        f"SELECT {corpus.RECORD_COLUMNS},sim_norm FROM entries WHERE id IN ({marks})", list(ids)
    )
    return [
        corpus.record_from_row(row)
        for row in rows
        if _plausible(probe, tokens, row["sim_norm"] or "", threshold)
    ]


def _rare_token_ids(con: sqlite3.Connection, tokens: set[str]) -> set[str]:
    """Records sharing one of the probe's rarest tokens (common ones are skipped)."""
    total = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
    cap = max(DF_FLOOR, DF_SHARE * total)
    frequencies = []
    for token in tokens:
        df = con.execute(
            "SELECT COUNT(*) FROM terms WHERE term=? AND in_sim=1", (token,)
        ).fetchone()[0]
        if df <= cap:
            frequencies.append((df, token))
    rare = [token for _df, token in sorted(frequencies)[:RARE_TOKENS]]
    if not rare:
        return set()
    marks = ",".join("?" for _ in rare)
    rows = con.execute(
        f"SELECT DISTINCT prompt_id FROM terms WHERE in_sim=1 AND term IN ({marks})", rare
    )
    return {row[0] for row in rows}


def _similar_size_ids(con: sqlite3.Connection, size: int) -> set[str]:
    """Records with about as many distinct tokens: short probes share few rare ones."""
    rows = con.execute(
        "SELECT prompt_id FROM terms WHERE in_sim=1 GROUP BY prompt_id "
        "HAVING COUNT(*) BETWEEN ? AND ?",
        (max(0, size - 1), size + 1),
    )
    return {row[0] for row in rows}


def _plausible(probe: str, tokens: set[str], other: str, threshold: float) -> bool:
    """The length bound on the ratio, then at least half the tokens in common."""
    if not 2 * min(len(probe), len(other)) >= float(threshold) * (len(probe) + len(other)):
        return False
    other_tokens = set(other.split())
    if not tokens or not other_tokens:
        return True
    return len(tokens & other_tokens) >= 0.5 * min(len(tokens), len(other_tokens))


def ids(con: sqlite3.Connection) -> list[str]:
    """Every record id, in creation order."""
    return [row[0] for row in con.execute("SELECT id FROM entries ORDER BY order_no")]
