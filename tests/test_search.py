"""Tests for prompt_librarian.search.

Deliberately free-standing: plain dict fixtures, no store, no conftest, no
``folder_paths``.  ``sys.path`` is fixed up here so the suite runs whether or
not another module in the pack has landed its own conftest.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from prompt_librarian import search as S  # noqa: E402

# --------------------------------------------------------------------------
# Fixtures (plain dicts matching the record schema)
# --------------------------------------------------------------------------


def mk(pid, name, body, **kw):
    return {
        "id": pid,
        "name": name,
        "body": body,
        "tags": kw.get("tags", []),
        "rating": kw.get("rating", 0),
        "used": kw.get("used", 0),
        "last_run": kw.get("last_run", ""),
        "created": kw.get("created", "2026-01-01T00:00:00Z"),
        "updated": kw.get("updated", "2026-01-01T00:00:00Z"),
        "notes": kw.get("notes", ""),
        "pinned": kw.get("pinned", False),
        "versions": kw.get("versions", []),
    }


@pytest.fixture
def records():
    return [
        mk("exact", "ballet drift", "a study of stage lighting only",
           tags=["stage"], used=3, updated="2026-02-01T00:00:00Z"),
        mk("phrase", "camera study",
           "a ballet drift across the stage at dusk",
           tags=["camera-move"], used=5, updated="2026-02-02T00:00:00Z"),
        mk("scatter", "stage notes",
           "a ballet performance with a slow lateral drift of the camera",
           tags=["dance"], used=9, updated="2026-02-03T00:00:00Z"),
        mk("ballerina", "ballerina spin",
           "she spins under volumetric haze, 35mm",
           tags=["dance", "camera-move"], used=41,
           last_run="2026-08-11T19:03:22Z", updated="2026-02-04T00:00:00Z"),
        mk("unrelated", "still life", "a bowl of fruit on a table",
           tags=["studio"], used=1,
           updated="2026-02-05T00:00:00Z"),
        mk("cjk", "猫の写真", "かわいい猫が窓辺で眠っている, Grüße aus München",
           tags=["cat"], used=0,
           updated="2026-02-06T00:00:00Z", versions=[{"body": "x"}]),
    ]


def ids(res):
    return [h["id"] for h in res["hits"]]


# --------------------------------------------------------------------------
# normalize / tokenize
# --------------------------------------------------------------------------


def test_normalize_pipeline():
    assert S.normalize("  Hello,   World!!  ") == "hello world"
    assert S.normalize("a\nb\tc") == "a b c"
    assert S.normalize(None) == ""
    assert S.normalize("") == ""


def test_normalize_uses_casefold_not_lower():
    # casefold folds sharp s to "ss"; lower() does not.
    assert S.normalize("STRASSE") == S.normalize("straße") == "strasse"
    assert "straße".lower() != "strasse"
    # Turkish dotted capital I: NFKC + casefold decomposes it to "i" plus a
    # combining dot, and the combining mark is not \w, so it splits. The
    # important part is that the word survives instead of vanishing.
    n = S.normalize("İstanbul")
    assert n.startswith("i") and "stanbul" in n
    assert S.normalize("İ") != ""


def test_normalize_keeps_cjk_and_accents():
    assert S.normalize("かわいい猫") == "かわいい猫"
    assert S.normalize("猫の写真") == "猫の写真"
    assert S.normalize("Grüße aus München") == "grüsse aus münchen"
    assert S.tokenize("猫の写真, café") == ["猫の写真", "café"]


def test_preview_collapses_newlines_and_truncates():
    body = "line one\n\nline two"
    assert S.preview(body) == "line one line two"
    long = "x" * 500
    p = S.preview(long)
    assert len(p) == S.PREVIEW_CHARS + 1 and p.endswith("…")


def test_within_edit_1():
    assert S._within_edit_1("ballet", "ballot")      # substitution
    assert S._within_edit_1("ballet", "ballets")     # insertion
    assert S._within_edit_1("ballet", "balle")       # deletion
    assert S._within_edit_1("ballet", "ballet")
    assert not S._within_edit_1("ballet", "ballets!!")   # length exit
    assert not S._within_edit_1("ballet", "balltе")      # two edits


# --------------------------------------------------------------------------
# Ranking
# --------------------------------------------------------------------------


def test_exact_name_beats_phrase_beats_scattered(records):
    res = S.search(records, "ballet drift", limit=10)
    order = ids(res)
    assert order[:3] == ["exact", "phrase", "scatter"]
    by = {h["id"]: h["score"] for h in res["hits"]}
    assert by["exact"] > by["phrase"] > by["scatter"]


def test_prefix_search_finds_longer_term(records):
    res = S.search(records, "ball", limit=10)
    found = set(ids(res))
    assert {"exact", "phrase", "scatter", "ballerina"} <= found
    assert "unrelated" not in found


def test_prefix_expansion_is_capped():
    recs = [mk(f"p{i}", f"n{i}", f"prefixaaa{i:04d}") for i in range(300)]
    idx = S.build_index(recs)
    assert len(idx.expand_prefix("prefixaaa")) == S.PREFIX_EXPAND_CAP


def test_zero_result_fallback_finds_edit_distance_1(records):
    # "ballrt" has no exact posting and no prefix expansion; only the
    # zero-result infix/edit-1 vocabulary scan can reach "ballet".
    res = S.search(records, "ballrt", limit=10)
    assert res["fallback"] is True
    assert "exact" in ids(res)


def test_happy_path_does_not_use_fallback(records):
    res = S.search(records, "ballet", limit=10)
    assert res["fallback"] is False


# --------------------------------------------------------------------------
# Operators
# --------------------------------------------------------------------------


def test_parse_query_operators():
    pq = S.parse_query('tag:Dance -fruit "dusk light" ballet')
    assert pq.tags == ("dance",)
    assert pq.excludes == ("fruit",)
    assert pq.phrases == ("dusk light",)
    assert "ballet" in pq.tokens and "dusk" in pq.tokens


def test_tag_operator(records):
    res = S.search(records, "tag:dance", limit=10)
    assert set(ids(res)) == {"scatter", "ballerina"}


def test_tag_operator_multiword_tag(records):
    res = S.search(records, 'tag:"camera-move"', limit=10)
    assert set(ids(res)) == {"phrase", "ballerina"}


def test_a_removed_field_operator_is_plain_text(records):
    """`cat:` is gone, so it tokenizes as ordinary words rather than filtering."""
    assert S.parse_query("cat:stills").tags == ()
    assert set(S.parse_query("cat:stills").tokens) == {"cat", "stills"}


def test_exclusion_operator(records):
    with_cam = set(ids(S.search(records, "camera", limit=10)))
    assert "scatter" in with_cam
    res = S.search(records, "camera -lateral", limit=10)
    assert "scatter" not in ids(res)


def test_quoted_phrase_requires_substring(records):
    res = S.search(records, '"ballet drift"', limit=10)
    got = set(ids(res))
    assert got == {"exact", "phrase"}      # "scatter" has the words far apart


def test_operators_and_with_chip_filters(records):
    res = S.search(records, "tag:dance", tags=["camera-move"], limit=10)
    assert set(ids(res)) == {"ballerina"}      # both must hold
    res2 = S.search(records, "tag:dance", tags=["studio"], limit=10)
    assert res2["hits"] == []


# --------------------------------------------------------------------------
# AND gate / mode
# --------------------------------------------------------------------------


def test_and_gate_rejects_doc_missing_a_token(records):
    res = S.search(records, "ballet unicorn", mode="all", limit=10)
    assert res["hits"] == []


def test_any_mode_keeps_partial_matches(records):
    res = S.search(records, "ballet unicorn", mode="any", limit=10)
    assert "exact" in ids(res)


def test_and_gate_across_fields(records):
    # "dance" only exists as a tag, "ballet" only in name/body: a doc is a hit
    # when each token matched in *some* field.
    res = S.search(records, "ballet dance", mode="all", limit=10)
    assert set(ids(res)) == {"scatter"}


# --------------------------------------------------------------------------
# Filters
# --------------------------------------------------------------------------


def test_tags_filter_is_and_not_or(records):
    both = S.search(records, "", tags=["dance", "camera-move"], limit=10)
    assert set(ids(both)) == {"ballerina"}
    one = S.search(records, "", tags=["dance"], limit=10)
    assert set(ids(one)) == {"scatter", "ballerina"}


def test_tags_filter_normalizes_like_stored_tags(records):
    res = S.search(records, "", tags=["Camera-Move"], limit=10)
    assert set(ids(res)) == {"phrase", "ballerina"}


def test_dupes_only_filter(records):
    res = S.search(records, "", dupes_only=True, dupe_ids={"exact", "phrase"},
                   limit=10)
    assert set(ids(res)) == {"exact", "phrase"}
    assert res["dupes_partial"] is True     # no dupe_count_fn was supplied


def test_dupes_only_without_ids_is_partial_not_empty(records):
    res = S.search(records, "", dupes_only=True, limit=10)
    assert len(res["hits"]) == 6
    assert res["dupes_partial"] is True


# --------------------------------------------------------------------------
# Empty query and sorting
# --------------------------------------------------------------------------


def test_empty_query_returns_all_with_zero_score_and_recent_order(records):
    res = S.search(records, "", limit=10)
    assert res["total"] == 6
    assert all(h["score"] == 0 for h in res["hits"])
    assert ids(res) == ["cjk", "unrelated", "ballerina", "scatter",
                        "phrase", "exact"]      # updated desc


def test_sort_recent_tiebreak_is_name(records):
    recs = [
        mk("b", "beta", "x", updated="2026-03-01T00:00:00Z"),
        mk("a", "alpha", "x", updated="2026-03-01T00:00:00Z"),
        mk("c", "gamma", "x", updated="2026-04-01T00:00:00Z"),
    ]
    assert ids(S.search(recs, "", sort="recent", limit=10)) == ["c", "a", "b"]


def test_sort_most_used_tiebreaks_on_last_run_then_name(records):
    recs = [
        mk("x", "x", "t", used=5, last_run="2026-01-01T00:00:00Z"),
        mk("y", "y", "t", used=5, last_run="2026-05-01T00:00:00Z"),
        mk("z", "z", "t", used=9, last_run=""),
        mk("w", "w", "t", used=5, last_run="2026-05-01T00:00:00Z"),
    ]
    assert ids(S.search(recs, "", sort="most_used", limit=10)) == ["z", "w", "y", "x"]


def test_sort_az_tiebreaks_on_used_desc():
    recs = [
        mk("low", "same name", "t", used=1),
        mk("high", "same name", "t", used=7),
        mk("first", "aaa", "t", used=0),
    ]
    assert ids(S.search(recs, "", sort="az", limit=10)) == ["first", "high", "low"]


def test_sort_relevance_tiebreaks_on_used_then_name():
    recs = [
        mk("a", "ballet", "ballet", used=1),
        mk("b", "ballet", "ballet", used=9),
    ]
    assert ids(S.search(recs, "ballet", sort="relevance", limit=10))[0] == "b"


def test_relevance_degrades_to_recent_on_empty_query(records):
    a = ids(S.search(records, "", sort="relevance", limit=10))
    b = ids(S.search(records, "", sort="recent", limit=10))
    assert a == b


def test_unknown_sort_falls_back_to_relevance(records):
    a = ids(S.search(records, "ballet", sort="bogus", limit=10))
    b = ids(S.search(records, "ballet", sort="relevance", limit=10))
    assert a == b


# --------------------------------------------------------------------------
# Result shape / paging / injected callables
# --------------------------------------------------------------------------


def test_result_envelope_and_hit_shape(records):
    res = S.search(records, "ballet", limit=2, offset=1, threshold=0.85, rev=7)
    assert set(res) >= {"rev", "total", "offset", "limit", "threshold",
                        "took_ms", "dupes_partial", "hits"}
    assert res["rev"] == 7 and res["offset"] == 1 and res["limit"] == 2
    assert res["threshold"] == 0.85
    assert isinstance(res["took_ms"], float)
    assert len(res["hits"]) == 2
    h = res["hits"][0]
    assert set(h) == {"id", "name", "preview", "tags", "rating",
                      "used", "last_run", "updated", "chars", "version_count",
                      "score", "dupe_count", "match_pct"}


def test_chars_and_version_count(records):
    res = S.search(records, "", limit=10)
    by = {h["id"]: h for h in res["hits"]}
    assert by["cjk"]["version_count"] == 1
    assert by["unrelated"]["chars"] == len("a bowl of fruit on a table")


def test_injected_dupe_and_match_callables(records):
    seen = {}

    def dupes(pids):
        seen["dupes"] = list(pids)
        return {pids[0]: 2}

    def match(pids):
        seen["match"] = list(pids)
        return {pids[0]: 0.964}

    res = S.search(records, "ballet", limit=2, dupe_count_fn=dupes, match_fn=match)
    assert len(seen["dupes"]) == 2          # current page only
    assert res["hits"][0]["dupe_count"] == 2
    assert res["hits"][0]["match_pct"] == 96
    assert res["hits"][1]["dupe_count"] == 0
    assert res["hits"][1]["match_pct"] is None
    assert res["dupes_partial"] is False


def test_paging(records):
    a = S.search(records, "", limit=2, offset=0)
    b = S.search(records, "", limit=2, offset=2)
    assert a["total"] == b["total"] == 6
    assert not set(ids(a)) & set(ids(b))


# --------------------------------------------------------------------------
# Index maintenance
# --------------------------------------------------------------------------


def test_incremental_add_matches_full_rebuild(records):
    full = S.build_index(records, rev=1)
    inc = S.SearchIndex(rev=1)
    for rec in records:
        inc.add(rec)
    assert inc.postings == full.postings
    assert inc.vocab == full.vocab == sorted(full.postings)
    assert set(inc.docs) == set(full.docs)


def test_incremental_remove_matches_full_rebuild(records):
    inc = S.build_index(records, rev=1)
    assert inc.remove("scatter") is True
    assert inc.remove("scatter") is False
    full = S.build_index([r for r in records if r["id"] != "scatter"], rev=1)
    assert inc.postings == full.postings
    assert inc.vocab == full.vocab
    assert "scatter" not in inc.docs and "scatter" not in inc.records


def test_incremental_replace_matches_full_rebuild(records):
    edited = dict(records[0], body="entirely different wording now", used=99)
    inc = S.build_index(records, rev=1)
    inc.replace(edited)
    full = S.build_index([edited] + records[1:], rev=1)
    assert inc.postings == full.postings
    assert inc.vocab == full.vocab
    assert inc.docs["exact"].used == 99


def test_vocab_stays_sorted_and_prunes_empty_postings():
    idx = S.build_index([mk("a", "zeta", "alpha bravo")], rev=1)
    idx.add(mk("b", "middle", "charlie"))
    assert idx.vocab == sorted(idx.vocab)
    assert "charlie" in idx.postings
    idx.remove("b")
    assert "charlie" not in idx.postings
    assert "charlie" not in idx.vocab
    assert idx.vocab == sorted(idx.vocab)


def test_search_accepts_a_prebuilt_index(records):
    idx = S.build_index(records, rev=12)
    res = S.search(idx, "ballet", limit=10)
    assert res["rev"] == 12


def test_search_accepts_a_duck_typed_store(records):
    class FakeStore:
        def __init__(self, recs):
            self._recs = recs
            self._rev = 3
            self.calls = 0

        def rev(self):
            return self._rev

        def list_all(self):
            self.calls += 1
            return self._recs

    st = FakeStore(records)
    S.invalidate_index()
    assert S.search(st, "ballet", limit=10)["rev"] == 3
    S.search(st, "ballet", limit=10)
    assert st.calls == 1                      # index cached until rev bumps
    st._rev = 4
    assert S.search(st, "ballet", limit=10)["rev"] == 4
    assert st.calls == 2
    S.invalidate_index()


def test_index_stats_are_recomputed_after_mutation(records):
    idx = S.build_index(records, rev=1)
    assert idx.max_used == 41
    idx.add(mk("boost", "boosted", "ballet", used=500))
    assert idx.max_used == 500
    idx.remove("boost")
    assert idx.max_used == 41


def test_empty_source_is_safe():
    res = S.search([], "ballet")
    assert res["total"] == 0 and res["hits"] == []
    assert S.search(None, "")["total"] == 0
