"""Library tables: creation, retired columns, and newer-schema detection."""

import json
import sqlite3

import pytest

from prompt_librarian.shared.db import schema


@pytest.fixture
def con():
    connection = sqlite3.connect(":memory:", isolation_level=None)
    yield connection
    connection.close()


def _tables(con):
    return {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def test_create_is_idempotent_and_records_the_schema(con):
    assert schema.create(con) == ()
    assert schema.create(con) == ()
    assert {"state", "entries", "tags", "metadata"} <= _tables(con)
    row = con.execute("SELECT value FROM state WHERE key='library_schema'").fetchone()
    assert row == (str(schema.SCHEMA_VERSION),)


def test_create_reports_retired_columns_an_old_library_still_has(con):
    schema.create(con)
    con.execute("ALTER TABLE entries ADD COLUMN off INTEGER NOT NULL DEFAULT 0")
    con.execute("ALTER TABLE entries ADD COLUMN seq INTEGER NOT NULL DEFAULT 0")
    assert schema.create(con) == ("off", "seq")


@pytest.mark.parametrize(
    ("payload", "newer"),
    [
        (None, False),
        ({"schema": schema.SCHEMA_VERSION}, False),
        ({"schema": schema.SCHEMA_VERSION + 1}, True),
    ],
)
def test_newer_schema(con, payload, newer):
    schema.create(con)
    if payload is not None:
        con.execute("INSERT INTO metadata VALUES (1, ?)", (json.dumps(payload),))
    assert schema.newer_schema(con) is newer


def test_invalid_metadata_is_a_database_error(con):
    schema.create(con)
    con.execute("INSERT INTO metadata VALUES (1, 'not json')")
    with pytest.raises(sqlite3.DatabaseError):
        schema.newer_schema(con)


def test_a_missing_metadata_table_is_not_newer(con):
    assert schema.newer_schema(con) is False
