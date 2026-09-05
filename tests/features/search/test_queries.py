"""Search candidates from SQLite: prefix match, all/any, and the fallbacks."""

import pytest

from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.features.search import queries


@pytest.fixture
def bodies(lib):
    ids = {body: create_prompt(lib, body)["id"] for body in ("red boat", "blue boat", "red car")}
    lib.prepare()
    return ids


def _found(lib, tokens, mode="all", fts5=None):
    with lib.read() as con:
        found = queries.candidate_records(con, tokens, mode, lib.fts5 if fts5 is None else fts5)
    return sorted(rec["body"] for rec in found)


@pytest.mark.parametrize("fts5", [True, False])
def test_prefix_tokens_with_all_and_any(lib, bodies, fts5):
    assert _found(lib, ["red", "bo"], "all", fts5) == ["red boat"]
    assert _found(lib, ["red", "bo"], "any", fts5) == ["blue boat", "red boat", "red car"]


def test_no_tokens_means_every_record(lib, bodies):
    assert len(_found(lib, [])) == 3


def test_a_miss_falls_back_to_infix_and_edit_distance(lib, bodies):
    assert _found(lib, ["oat"]) == ["blue boat", "red boat"]  # infix
    assert _found(lib, ["boet"]) == ["blue boat", "red boat"]  # one edit away


def test_a_broken_fts_table_falls_back_to_postings(lib, bodies):
    with lib.db.write() as con:
        con.execute("DROP TABLE prompt_fts")
    assert _found(lib, ["red"], fts5=True) == ["red boat", "red car"]


def test_statistics(lib, bodies):
    with lib.read() as con:
        assert queries.corpus_stats(con)["count"] == 3
        assert queries.term_df(con, "RED") == 2


def test_the_source_caches_statistics_per_revision(lib, bodies, monkeypatch):
    from prompt_librarian.features.search import LibrarySearchSource

    source = LibrarySearchSource(lib)
    assert source.term_df("red") == 2
    monkeypatch.setattr(queries, "term_df", lambda *_: pytest.fail("not cached"))
    assert source.term_df("red") == 2
    monkeypatch.undo()
    create_prompt(lib, "red kite")
    assert source.term_df("red") == 3
    assert isinstance(source.corpus_stats()["updated"], list)
