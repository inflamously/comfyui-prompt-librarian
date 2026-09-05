"""Record rows stay consistent with the corpus and with registered projectors."""

from prompt_librarian.features.prompts import get, update
from prompt_librarian.features.prompts.bulk import bulk_delete
from prompt_librarian.features.prompts.create import create_prompt
from prompt_librarian.features.storage.records import replace_prompts


def _terms(lib, pid):
    with lib.read() as con:
        return {row[0] for row in con.execute("SELECT term FROM terms WHERE prompt_id=?", (pid,))}


def test_projectors_see_the_previous_body(lib):
    calls = []
    lib.extend(projector=lambda _con, _pid, p, prev: calls.append((p and p["body"], prev)))
    rec = create_prompt(lib, "one")
    update.update_prompt(lib, rec["id"], body="two")
    update.update_prompt(lib, rec["id"], rating=2)
    bulk_delete(lib, [rec["id"]])
    assert calls == [("one", None), ("two", "one"), ("two", "two"), (None, "two")]


def test_postings_follow_the_body(lib):
    rec = create_prompt(lib, "red boat", tags=["sea"])
    assert _terms(lib, rec["id"]) == {"red", "boat", "sea"}
    update.update_prompt(lib, rec["id"], body="blue boat")
    assert _terms(lib, rec["id"]) == {"blue", "boat", "sea"}
    bulk_delete(lib, [rec["id"]])
    assert _terms(lib, rec["id"]) == set()


def test_an_edit_keeps_creation_order(lib):
    a, b = create_prompt(lib, "a"), create_prompt(lib, "b")
    update.update_prompt(lib, a["id"], body="a2")
    assert get.prompt_ids(lib) == [a["id"], b["id"]]


def test_replace_rewrites_records_and_envelope_together(lib, changes):
    create_prompt(lib, "old")
    replace_prompts(lib, [{**create_prompt(lib, "tmp"), "id": "new", "body": "new"}],
                    lambda _stored: {"schema": 1, "settings": {"version_cap": 3}})
    assert get.prompt_ids(lib) == ["new"]
    with lib.read() as con:
        assert con.execute("SELECT payload FROM metadata").fetchone()[0] == (
            '{"schema":1,"settings":{"version_cap":3}}'
        )
    assert changes[-1].op == "import"
