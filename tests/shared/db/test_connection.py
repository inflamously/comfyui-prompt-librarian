"""One reused connection per thread, and transactions that commit or roll back."""

import os
import sqlite3
import threading
import time

import pytest

from prompt_librarian.shared.db.connection import Database


@pytest.fixture
def db(tmp_path):
    database = Database(str(tmp_path / "lib" / "library.sqlite3"))
    with database.write() as con:
        con.execute("CREATE TABLE t (v INTEGER)")
    yield database
    database.close()


def _count(db):
    with db.read() as con:
        return con.execute("SELECT COUNT(*) FROM t").fetchone()[0]


def test_a_thread_reuses_its_connection(db):
    assert db.connection() is db.connection()


def test_each_thread_gets_its_own_connection(db):
    seen = []
    worker = threading.Thread(target=lambda: seen.append(db.connection()))
    worker.start()
    worker.join()
    assert seen[0] is not db.connection()


def test_a_write_commits_on_success(db):
    with db.write() as con:
        con.execute("INSERT INTO t VALUES (1)")
    assert _count(db) == 1


def _insert_then_fail(db, *values):
    with db.write() as outer:
        for value in values:
            with db.write() as con:  # nested writes join the outer transaction
                con.execute("INSERT INTO t VALUES (?)", (value,))
        outer.execute("SELECT 1")
        raise RuntimeError("boom")


def test_a_write_rolls_back_on_error(db):
    with pytest.raises(RuntimeError):
        _insert_then_fail(db, 1)
    assert _count(db) == 0
    assert not db.connection().in_transaction


def test_a_nested_transaction_joins_the_outer_one(db):
    with pytest.raises(RuntimeError):
        _insert_then_fail(db, 1, 2)
    assert _count(db) == 0, "the inner writes rolled back with the outer one"


def test_a_write_waits_for_another_writer(db):
    ready = threading.Event()

    def hold():
        con = sqlite3.connect(db.path)
        con.execute("BEGIN IMMEDIATE")
        ready.set()
        time.sleep(0.3)
        con.rollback()
        con.close()

    holder = threading.Thread(target=hold)
    holder.start()
    ready.wait(5)
    started = time.monotonic()
    with db.write() as con:
        con.execute("INSERT INTO t VALUES (1)")
    holder.join()
    assert time.monotonic() - started >= 0.25
    assert _count(db) == 1


def test_a_replaced_file_gets_a_fresh_connection(db):
    before = db.connection()
    db.close()
    os.remove(db.path)
    replacement = sqlite3.connect(db.path)
    replacement.execute("CREATE TABLE t (v INTEGER)")
    replacement.execute("INSERT INTO t VALUES (7)")
    replacement.commit()
    replacement.close()

    assert db.connection() is not before
    assert _count(db) == 1


def test_close_closes_every_thread_s_connection(db):
    others = []
    worker = threading.Thread(target=lambda: others.append(db.connection()))
    worker.start()
    worker.join()
    db.close()
    with pytest.raises(sqlite3.ProgrammingError):
        others[0].execute("SELECT 1")
    assert _count(db) == 0, "a closed database reopens on the next use"
