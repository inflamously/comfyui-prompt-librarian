"""The state table and the library revision."""

import sqlite3

import pytest

from prompt_librarian.shared.db import state


@pytest.fixture
def con():
    connection = sqlite3.connect(":memory:")
    connection.execute("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    yield connection
    connection.close()


def test_a_new_library_is_at_revision_zero(con):
    assert state.revision(con) == 0


def test_bump_returns_the_revision_it_replaced(con):
    assert state.bump(con) == (0, 1)
    assert state.bump(con) == (1, 2)
    assert state.revision(con) == 2


def test_put_overwrites(con):
    state.put(con, "k", 1)
    state.put(con, "k", 2)
    assert state.get(con, "k") == "2"
    assert state.get(con, "missing") is None
