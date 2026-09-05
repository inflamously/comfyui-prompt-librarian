"""The search/dupe projection: normalized forms, postings and the FTS row."""

import sqlite3

import pytest

from prompt_librarian.shared import corpus
from prompt_librarian.shared.db import schema
from prompt_librarian.shared.records import index_entry


@pytest.fixture
def con():
    connection = sqlite3.connect(":memory:", isolation_level=None)
    connection.execute("PRAGMA foreign_keys=ON")
    schema.create(connection)
    yield connection
    connection.close()


def _record(pid="a", body="Straße, Café au lait!", tags=("Warm Light",)):
    return {"id": pid, "body": body, "tags": list(tags), "notes": "n"}


def test_projection_carries_normalized_forms():
    rec = _record()
    p = corpus.projection(rec, index_entry(rec))
    assert p["body_norm"] == "strasse café au lait"
    assert p["tags_norm"] == "warm light"
    assert p["sim_norm"] == p["body_norm"]
    assert p["preview"] == "Straße, Café au lait!"


def test_sim_norm_is_capped():
    rec = _record(body="word " * 2000)
    assert len(corpus.projection(rec, index_entry(rec))["sim_norm"]) == corpus.SIM_MAX_CHARS


def _postings(con):
    return con.execute("SELECT term,in_body,in_tag,in_head FROM terms ORDER BY term").fetchall()


def test_write_replaces_postings_and_fts(con):
    fts5 = corpus.create(con)
    con.execute("INSERT INTO entries(id,order_no,tags_json,rating,used,pinned,created,updated,"
                "last_run,chars,versions,preview,body,body_norm,tags_norm,sim_norm,notes) "
                "VALUES('a',0,'[]',0,0,0,'','','',0,0,'','','','','','')")
    rec = _record(body="red boat", tags=("sea",))
    corpus.write(con, corpus.projection(rec, index_entry(rec)), fts5)
    assert _postings(con) == [("boat", 1, 0, 1), ("red", 1, 0, 1), ("sea", 0, 1, 0)]

    rec = _record(body="blue boat", tags=())
    corpus.write(con, corpus.projection(rec, index_entry(rec)), fts5)
    assert [row[0] for row in _postings(con)] == ["blue", "boat"]
    if fts5:
        assert con.execute("SELECT body FROM prompt_fts").fetchall() == [("blue boat",)]

    corpus.delete(con, "a", fts5)
    con.execute("DELETE FROM entries WHERE id='a'")
    assert _postings(con) == [], "postings cascade with the entries row"
    assert not corpus.has_fts(con) or not con.execute("SELECT * FROM prompt_fts").fetchall()
