"""Disposable, transactional vocabulary from current saved bodies only."""

import re
import unicodedata

VERSION = "2"
MAX_COMPLETION_WORDS = 3
BATCH_SIZE = 250


def normalize(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def words(text):
    """Unicode letters/numbers/marks and underscores, retaining saved spelling."""
    token = []
    for char in text:
        if char == "_" or unicodedata.category(char)[0] in "LNM":
            token.append(char)
        elif token:
            yield "".join(token)
            token.clear()
    if token:
        yield "".join(token)


def phrases(body):
    """Keep short dictionary phrases; never learn a long sentence as one entry."""
    for fragment in re.split(r"[,\r\n]", body):
        word_count = sum(1 for _ in words(fragment))
        if 1 <= word_count <= MAX_COMPLETION_WORDS:
            yield fragment


def extract(body):
    found = {}
    for scope, values in enumerate((words(body), phrases(body))):
        for value in values:
            spelling = value.strip()
            key = normalize(spelling)
            if key:
                item = found.setdefault(key, [spelling, 0, 0])
                item[scope + 1] = 1
    return found


def put(con, pid, body):
    con.execute("DELETE FROM autocomplete_sources WHERE prompt_id=?", (pid,))
    for key, (text, word, phrase) in extract(body).items():
        con.execute(
            "INSERT OR IGNORE INTO autocomplete_keywords(keyword,text) VALUES(?,?)", (key, text)
        )
        con.execute(
            "INSERT INTO autocomplete_sources(prompt_id,keyword,word,phrase) VALUES(?,?,?,?)",
            (pid, key, word, phrase),
        )


def initialize(con):
    """Backfill bounded batches inside the caller's transaction, version last."""
    con.execute("""CREATE TABLE IF NOT EXISTS autocomplete_keywords (
        keyword TEXT PRIMARY KEY, text TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0,
        word_count INTEGER NOT NULL DEFAULT 0, phrase_count INTEGER NOT NULL DEFAULT 0
    )""")
    con.execute("""CREATE TABLE IF NOT EXISTS autocomplete_sources (
        prompt_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL REFERENCES autocomplete_keywords(keyword),
        word INTEGER NOT NULL, phrase INTEGER NOT NULL,
        PRIMARY KEY(prompt_id, keyword)
    )""")
    con.execute(
        "CREATE INDEX IF NOT EXISTS autocomplete_sources_keyword "
        "ON autocomplete_sources(keyword,prompt_id)"
    )
    con.execute("""CREATE TRIGGER IF NOT EXISTS autocomplete_add
        AFTER INSERT ON autocomplete_sources BEGIN
        UPDATE autocomplete_keywords SET source_count=source_count+1,
            word_count=word_count+NEW.word, phrase_count=phrase_count+NEW.phrase
            WHERE keyword=NEW.keyword;
    END""")
    con.execute("""CREATE TRIGGER IF NOT EXISTS autocomplete_remove
        AFTER DELETE ON autocomplete_sources BEGIN
        UPDATE autocomplete_keywords SET source_count=source_count-1,
            word_count=word_count-OLD.word, phrase_count=phrase_count-OLD.phrase
            WHERE keyword=OLD.keyword;
        DELETE FROM autocomplete_keywords WHERE keyword=OLD.keyword AND source_count=0;
    END""")
    row = con.execute("SELECT value FROM state WHERE key='autocomplete_version'").fetchone()
    if row and row[0] == VERSION:
        return
    con.execute("DELETE FROM autocomplete_sources")
    con.execute("DELETE FROM autocomplete_keywords")
    cursor = con.execute("SELECT id,body FROM entries ORDER BY id")
    while batch := cursor.fetchmany(BATCH_SIZE):
        for row in batch:
            put(con, row[0], row[1])
    con.execute(
        "INSERT INTO state(key,value) VALUES('autocomplete_version',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (VERSION,),
    )


# Explicit binary ranges use the primary-key index; %, _ and template syntax
# remain literal. NFKC + casefold handles Unicode beyond SQLite's ASCII NOCASE.
PREFIX_SQL = """SELECT keyword,text,source_count FROM autocomplete_keywords
    WHERE keyword >= ? AND keyword < ? AND {scope}_count > 0
    ORDER BY source_count DESC, keyword LIMIT ?"""


def prefix_end(prefix):
    for i in range(len(prefix) - 1, -1, -1):
        if ord(prefix[i]) < 0x10FFFF:
            return prefix[:i] + chr(ord(prefix[i]) + 1)
    return None


def suggest(con, word_prefix, phrase_prefix, limit):
    found = {}
    for scope, raw in (("word", word_prefix), ("phrase", phrase_prefix)):
        prefix = normalize(raw)
        end = prefix_end(prefix)
        if not prefix or end is None:
            continue
        rows = con.execute(PREFIX_SQL.format(scope=scope), (prefix, end, limit))
        for row in rows:
            found.setdefault(
                row["keyword"],
                {"text": row["text"], "scope": scope, "source_count": row["source_count"]},
            )
    return [
        item
        for _, item in sorted(found.items(), key=lambda pair: (-pair[1]["source_count"], pair[0]))
    ][:limit]
