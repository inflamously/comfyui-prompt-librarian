"""Reads of a library that was never written are empty and create nothing."""

import os

from prompt_librarian.features.prompts import get
from prompt_librarian.features.prompts.create import create_prompt


def test_reading_a_missing_library_creates_no_file(lib):
    assert get.get_prompt(lib, "x") is None
    assert get.get_prompts(lib, ["x"]) == {}
    assert get.all_prompts(lib) == []
    assert get.prompt_ids(lib) == []
    assert get.count_prompts(lib) == 0
    assert not os.path.exists(lib.path)


def test_reads_return_records_in_creation_order(lib):
    a = create_prompt(lib, "first", tags=["x", "y"])
    b = create_prompt(lib, "second", tags=["y"])
    assert get.prompt_ids(lib) == [a["id"], b["id"]]
    assert [rec["body"] for rec in get.all_prompts(lib)] == ["first", "second"]
    assert get.get_prompts(lib, [b["id"], "missing"]) == {b["id"]: b}
