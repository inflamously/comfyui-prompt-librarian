"""Completions come from saved bodies; a missing or newer library has none."""

import json
import os

from prompt_librarian.features.autocomplete import vocabulary
from prompt_librarian.features.autocomplete.suggest import suggest
from prompt_librarian.features.prompts.create import create_prompt


def test_suggest_needs_the_vocabulary_extension(lib):
    lib.extend(setup=vocabulary.initialize, projector=vocabulary.project)
    create_prompt(lib, "golden hour light, soft light")
    words = [item["text"] for item in suggest(lib, word_prefix="gol")]
    assert words == ["golden"]


def test_a_missing_library_suggests_nothing_and_creates_nothing(lib):
    assert suggest(lib, word_prefix="a") == []
    assert not os.path.exists(lib.path)


def test_a_newer_schema_suggests_nothing(lib):
    lib.extend(setup=vocabulary.initialize, projector=vocabulary.project)
    create_prompt(lib, "future words")
    with lib.db.write() as con:
        con.execute("INSERT OR REPLACE INTO metadata VALUES (1, ?)", (json.dumps({"schema": 99}),))
    assert suggest(lib, word_prefix="fut") == []
