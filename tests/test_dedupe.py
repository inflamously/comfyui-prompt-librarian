"""Tests for librarian_dedupe.

Free-standing: plain dict fixtures, no store, no conftest, no ``folder_paths``.
"""

import difflib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

import librarian_dedupe as D  # noqa: E402


# The plan's canonical near-duplicate pair.
CANON_A = "make him dance ballet slowly drifting toward the camera, dusk light"
CANON_B = ("make him dance ballet slowly drifting towards the camera, "
           "dusk light, volumetric haze")


def mk(pid, name, body, **kw):
    return {
        "id": pid,
        "name": name,
        "body": body,
        "category": kw.get("category", "videogen_edit_minimax"),
        "tags": kw.get("tags", []),
        "rating": kw.get("rating", 0),
        "used": kw.get("used", 0),
        "last_run": kw.get("last_run", ""),
        "created": kw.get("created", "2026-01-01T00:00:00Z"),
        "updated": kw.get("updated", "2026-01-01T00:00:00Z"),
        "notes": "",
        "pinned": False,
        "versions": [],
    }


@pytest.fixture(autouse=True)
def _clean_caches():
    D.invalidate()
    yield
    D.invalidate()


@pytest.fixture
def records():
    return [
        mk("a1", "ballet_drift_v3", CANON_A, used=41,
           updated="2026-08-11T19:03:22Z"),
        mk("a2", "ballet_drift_v4", CANON_B, used=2,
           updated="2026-08-12T10:00:00Z"),
        mk("b1", "fruit_bowl", "a bowl of fruit on a wooden table, north light"),
        mk("b2", "fruit_bowl_alt",
           "a bowl of fruit on a wooden table, north lights"),
        mk("c1", "long_one",
           "a very different prompt about spaceships and asteroid mining rigs "
           "drifting through a debris field near jupiter at high speed"),
    ]


# --------------------------------------------------------------------------
# ratio() cascade and autojunk
# --------------------------------------------------------------------------


def test_ratio_cascade_returns_zero_below_threshold():
    assert D.ratio("abcdefgh", "abcdefgh", 0.9) == 1.0
    assert D.ratio("abcdefgh", "zzzzzzzz", 0.9) == 0.0
    # above the cheap bounds but below the real ratio -> still zeroed
    assert D.ratio("abcdefgh", "abcdefzz", 0.9) == 0.0
    assert D.ratio("abcdefgh", "abcdefzz", 0.0) == 0.75


def test_ratio_of_identical_long_text_is_one():
    s = D.sim_norm("volumetric haze " * 40)
    assert D.ratio(s, s, 0.9) == 1.0


def test_sim_norm_normalizes_and_caps():
    assert D.sim_norm("  Toward   THE Camera, dusk\n light ") == \
        "toward the camera dusk light"
    big = "word " * 5000
    assert len(D.sim_norm(big)) == D.SIM_MAX_CHARS


def test_autojunk_regression_long_near_identical_pair():
    """With autojunk=True difflib treats every common character as junk.

    Both strings are > 200 characters and differ only by an inserted clause,
    which is exactly the near-duplicate shape this feature exists to catch.
    """
    head = "a slow tracking shot of the room, "
    tail = "soft warm light on the floor, gentle motion, warm tones, " * 4
    a = D.sim_norm(head + tail)
    b = D.sim_norm(head + "in a moment, " + tail)
    assert len(a) > 200 and len(b) > 200

    good = D.ratio(a, b, 0.0)
    assert good >= 0.95

    # Same comparison with the default heuristic: materially lower.
    bad = difflib.SequenceMatcher(None, a, b, autojunk=True).ratio()
    assert bad < good - 0.30
    assert difflib.SequenceMatcher(None, a, b, autojunk=True).bpopular


def test_ratio_call_sites_disable_autojunk(monkeypatch):
    seen = []

    class Spy(difflib.SequenceMatcher):
        def __init__(self, isjunk=None, a="", b="", autojunk=True):
            seen.append(autojunk)
            super().__init__(isjunk, a, b, autojunk)

    monkeypatch.setattr(D.difflib, "SequenceMatcher", Spy)
    D.ratio(D.sim_norm(CANON_A), D.sim_norm(CANON_B), 0.0)
    D.diff_tokens(CANON_A, CANON_B)
    assert seen and all(flag is False for flag in seen)


# --------------------------------------------------------------------------
# The canonical pair
# --------------------------------------------------------------------------


def test_canonical_pair_diff_summary_exact_string():
    assert D.diff_summary(CANON_A, CANON_B) == '“toward” → “towards”, + volumetric haze'


def test_canonical_pair_score_and_detection_threshold():
    """The canonical pair scores 0.886, i.e. *just* under a 0.90 default.

    ``ratio()`` is the plan's mandated formula (2*M/(la+lb)), and these two
    strings are short enough (66 / 83 normalized characters) that the 16-char
    appended clause alone costs ~11 points. The same append on a realistic
    300-character prompt scores > 0.95 (asserted below), so the gap is a
    property of the toy example, not of the cascade. Flagged for the caller:
    with ``dupe_threshold`` left at 0.90 this exact pair is *not* reported.
    """
    score = D.ratio(D.sim_norm(CANON_A), D.sim_norm(CANON_B), 0.0)
    assert 0.88 <= score < 0.90
    assert D.ratio(D.sim_norm(CANON_A), D.sim_norm(CANON_B), 0.88) == score
    assert D.ratio(D.sim_norm(CANON_A), D.sim_norm(CANON_B), 0.90) == 0.0

    # Same edit + same append, realistic prompt length -> comfortably over 0.90
    filler = ", 35mm film grain, soft rim light, shallow depth of field, " \
             "muted teal palette, slow dolly in, gentle wind in the curtains"
    long_a = CANON_A + filler
    long_b = CANON_B + filler
    assert D.ratio(D.sim_norm(long_a), D.sim_norm(long_b), 0.90) >= 0.95


def test_canonical_pair_found_by_find_similar(records):
    idx = D.build_dupe_index(records, rev=1)
    hits = D.find_similar(idx, pid="a1", exclude_id="a1", threshold=0.88)
    assert [h["id"] for h in hits] == ["a2"]
    hit = hits[0]
    assert set(hit) == {"id", "name", "score", "pct", "summary", "preview",
                        "used", "updated"}
    assert hit["pct"] == 89
    assert hit["summary"] == '“toward” → “towards”, + volumetric haze'
    assert hit["name"] == "ballet_drift_v4"


# --------------------------------------------------------------------------
# Blocking: precision and recall
# --------------------------------------------------------------------------


def test_length_ok_rejects_a_genuinely_different_length_pair():
    assert D.length_ok(100, 105, 0.90) is True
    assert D.length_ok(10, 100, 0.90) is False
    assert D.length_ok(100, 130, 0.90) is False


def test_prefilter_does_not_lose_a_known_pair(records):
    idx = D.build_dupe_index(records, rev=1)
    hits = D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90)
    assert [h["id"] for h in hits] == ["b2"]
    assert hits[0]["score"] >= 0.90


def test_short_document_pair_needs_the_length_bucket_escape_hatch(monkeypatch):
    """2-token documents share only common tokens; rare-token blocking finds
    nothing, and only the adjacent-length-bucket pull recovers them."""
    monkeypatch.setattr(D, "DF_ABS", 0)
    monkeypatch.setattr(D, "DF_FRAC", 0.0)
    recs = [
        mk("s1", "dusk", "dusk light"),
        mk("s2", "dusk2", "dusk lights"),
        mk("s3", "other", "a completely unrelated prompt about spaceships "
                          "drifting past jupiter at high speed"),
    ]
    idx = D.build_dupe_index(recs, rev=1)

    # stage 1 by rare tokens alone is empty at this df cap
    assert all(idx.df(t) > max(D.DF_ABS, D.DF_FRAC * len(idx)) for t in idx.toks["s1"])

    hits = D.find_similar(idx, pid="s1", exclude_id="s1", threshold=0.90)
    assert [h["id"] for h in hits] == ["s2"]

    # remove the escape hatch and the pair is lost -- proving it is load-bearing
    idx.length_buckets = {}
    D.invalidate()
    assert D.find_similar(idx, pid="s1", exclude_id="s1", threshold=0.90) == []


def test_candidates_apply_length_and_overlap_prefilters():
    recs = [
        mk("short", "s", "dusk light"),
        mk("long", "l", "dusk light " * 30),
        mk("near", "n", "dusk lights"),
    ]
    idx = D.build_dupe_index(recs, rev=1)
    toks = idx.toks["short"]
    cand = idx.candidates(toks, len(idx.norms["short"]), 0.90, exclude=("short",))
    assert "near" in cand
    assert "long" not in cand          # killed by length_ok


def test_exhaustive_flag_skips_blocking(records):
    blocked = D.dupe_counts(records, 0.90, rev=1)
    exhaustive = D.dupe_counts(records, 0.90, rev=1, exhaustive=True)
    assert blocked["counts"] == exhaustive["counts"]
    assert exhaustive["exhaustive"] is True


# --------------------------------------------------------------------------
# find_similar semantics
# --------------------------------------------------------------------------


def test_exclude_id_prevents_self_matching_at_100(records):
    idx = D.build_dupe_index(records, rev=1)
    with_self = D.find_similar(idx, text=CANON_A, threshold=0.90)
    assert [h["id"] for h in with_self] == ["a1"] and with_self[0]["pct"] == 100
    without = D.find_similar(idx, text=CANON_A, exclude_id="a1", threshold=0.90)
    assert [h["id"] for h in without] == []


def test_ignored_pairs_are_excluded(records):
    idx = D.build_dupe_index(records, rev=1)
    assert D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90)
    quiet = D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90,
                           ignored=[("b2", "b1")])       # order-insensitive
    assert quiet == []


def test_with_summary_false_skips_the_diff(records):
    idx = D.build_dupe_index(records, rev=1)
    hits = D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90,
                          with_summary=False)
    assert hits and hits[0]["summary"] == ""


def test_limit_and_sort_order():
    body = "soft warm light on the floor, gentle motion, warm tones"
    recs = [mk("p%d" % i, "p%d" % i, body + ("!" * i)) for i in range(6)]
    idx = D.build_dupe_index(recs, rev=1)
    hits = D.find_similar(idx, pid="p0", exclude_id="p0", threshold=0.90, limit=3)
    assert len(hits) == 3
    assert [h["score"] for h in hits] == sorted((h["score"] for h in hits),
                                               reverse=True)


def test_find_similar_on_plain_list_and_empty_text(records):
    hits = D.find_similar(records, text=CANON_A, exclude_id="a1", threshold=0.88)
    assert [h["id"] for h in hits] == ["a2"]
    assert D.find_similar(records, text="   ", threshold=0.9) == []
    assert D.find_similar(records, threshold=0.9) == []


# --------------------------------------------------------------------------
# Caches
# --------------------------------------------------------------------------


def test_one_cache_hit_returns_identical_object_without_recomputing(records, monkeypatch):
    idx = D.build_dupe_index(records, rev=5)
    calls = {"n": 0}
    real = D.ratio

    def counting(a, b, t=0.0):
        calls["n"] += 1
        return real(a, b, t)

    monkeypatch.setattr(D, "ratio", counting)

    first = D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90)
    assert calls["n"] > 0
    n_after_first = calls["n"]

    second = D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90)
    assert second is first                      # identical object
    assert calls["n"] == n_after_first          # nothing recomputed
    assert D.cache_stats()["one_hits"] >= 1


def test_one_cache_is_keyed_on_normalized_text(records):
    idx = D.build_dupe_index(records, rev=5)
    a = D.find_similar(idx, text=CANON_A, exclude_id="a1", threshold=0.88)
    b = D.find_similar(idx, text="  MAKE   him Dance BALLET slowly drifting "
                                 "toward the camera; dusk light  ",
                       exclude_id="a1", threshold=0.88)
    assert b is a                               # case/whitespace-only edits hit


def test_unversioned_source_is_never_cached(records):
    a = D.find_similar(records, text=CANON_A, exclude_id="a1", threshold=0.88)
    b = D.find_similar(records, text=CANON_A, exclude_id="a1", threshold=0.88)
    assert a == b and a is not b


def test_invalidate_drops_by_rev(records):
    idx = D.build_dupe_index(records, rev=5)
    first = D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90)
    D.invalidate(rev=5)
    second = D.find_similar(idx, pid="b1", exclude_id="b1", threshold=0.90)
    assert second == first and second is not first


def test_all_cache_hits(records):
    a = D.dupe_counts(records, 0.90, rev=9)
    b = D.dupe_counts(records, 0.90, rev=9)
    assert b is a
    assert D.cache_stats()["all_hits"] >= 1
    c = D.dupe_counts(records, 0.95, rev=9)
    assert c is not a


# --------------------------------------------------------------------------
# All-pairs
# --------------------------------------------------------------------------


def test_dupe_counts_counts_and_groups(records):
    res = D.dupe_counts(records, 0.90, rev=1)
    assert res["counts"] == {"a1": 0, "a2": 0, "b1": 1, "b2": 1, "c1": 0}
    assert res["groups"] == [["b1", "b2"]]
    assert D.dupe_ids(res) == {"b1", "b2"}
    assert res["pairs"]["b1"]["b2"] >= 0.90


def test_dupe_counts_lower_threshold_pulls_in_the_canonical_pair(records):
    res = D.dupe_counts(records, 0.88, rev=2)
    assert res["counts"]["a1"] == 1 and res["counts"]["a2"] == 1
    assert ["a1", "a2"] in res["groups"]


def test_dupe_counts_clusters_transitively():
    recs = [
        mk("g1", "g1", "soft warm light on the floor gentle motion warm tones"),
        mk("g2", "g2", "soft warm light on the floor gentle motion warm tone"),
        mk("g3", "g3", "soft warm light on the floor gentle motion warm tuner"),
        mk("solo", "solo", "an entirely different subject: neon rain in tokyo"),
    ]
    res = D.dupe_counts(recs, 0.90, rev=1)
    assert res["groups"] == [["g1", "g2", "g3"]]
    assert res["counts"]["solo"] == 0


def test_dupe_counts_honours_ignored(records):
    res = D.dupe_counts(records, 0.90, rev=1, ignored=[("b1", "b2")])
    assert res["counts"]["b1"] == 0 and res["groups"] == []


def test_page_dupe_counts_only_touches_requested_ids(records):
    counts = D.page_dupe_counts(records, ["b1", "c1"], 0.90)
    assert counts == {"b1": 1, "c1": 0}
    assert D.page_dupe_counts(records, ["b1"], 0.90, ignored=[("b1", "b2")]) == {"b1": 0}
    assert D.page_dupe_counts(records, ["nope"], 0.90) == {"nope": 0}


def test_patch_updates_a_cached_all_pairs_result(records):
    idx = D.build_dupe_index(records, rev=1)
    base = D.dupe_counts(idx, 0.90, rev=1)
    assert base["counts"]["b1"] == 1

    old = records[2]                                     # b1
    new = dict(old, body="a totally unrelated haiku about winter rain",
               updated="2026-09-01T00:00:00Z")
    patched = D.patch(old, new, 0.90, old_rev=1, new_rev=2, source=idx)
    assert patched is not None
    assert patched["rev"] == 2
    assert patched["counts"]["b1"] == 0 and patched["counts"]["b2"] == 0
    assert patched["groups"] == []

    # the patched result is now the cached one for rev 2
    assert D.dupe_counts(idx, 0.90, rev=2) is patched

    # and it agrees with a cold full recompute
    fresh = D.dupe_counts([new if r["id"] == "b1" else r for r in records],
                          0.90, rev=3)
    assert fresh["counts"] == patched["counts"]


def test_patch_handles_delete_and_missing_cache(records):
    idx = D.build_dupe_index(records, rev=1)
    D.dupe_counts(idx, 0.90, rev=1)
    patched = D.patch(records[2], None, 0.90, old_rev=1, new_rev=2, source=idx)
    assert "b1" not in patched["counts"]
    assert patched["counts"]["b2"] == 0
    D.invalidate()
    assert D.patch(records[2], None, 0.90, old_rev=1, new_rev=2, source=idx) is None


# --------------------------------------------------------------------------
# Word-level diff
# --------------------------------------------------------------------------


def test_diff_tokens_opcodes_reconstruct_both_inputs():
    a, b = CANON_A, CANON_B
    chunks = D.diff_tokens(a, b)
    a_out, b_out = [], []
    for c in chunks:
        a_out.extend(c["a_tokens"])
        b_out.extend(c["b_tokens"])
    assert a_out == a.split()
    assert b_out == b.split()
    assert any(c["op"] == "equal" for c in chunks)          # equal runs kept
    assert set(chunks[0]) == {"op", "a_start", "a_end", "b_start", "b_end",
                              "a_tokens", "b_tokens"}


def test_diff_tokens_indices_are_consistent():
    chunks = D.diff_tokens(CANON_A, CANON_B)
    ai = bi = 0
    for c in chunks:
        assert c["a_start"] == ai and c["b_start"] == bi
        ai, bi = c["a_end"], c["b_end"]
    assert ai == len(CANON_A.split()) and bi == len(CANON_B.split())


def test_diff_tokens_is_capped():
    a = " ".join("w%d" % i for i in range(6000))
    b = " ".join("x%d" % i for i in range(6000))
    assert len(D.diff_tokens(a, b)) <= D.DIFF_OPCODE_CAP


def test_tok_pairs_keys_ignore_case_and_edge_punctuation():
    disp, keys = D._tok_pairs("Camera, — “Dusk”")
    assert disp == ["Camera,", "—", "“Dusk”"]
    assert keys[0] == "camera" and keys[2] == "dusk"
    assert keys[1] == "—"                        # pure punctuation keeps itself


def test_diff_renders_display_tokens_not_keys():
    chunks = D.diff_tokens("toward the Camera,", "towards the Camera,")
    rep = [c for c in chunks if c["op"] == "replace"][0]
    assert rep["a_tokens"] == ["toward"] and rep["b_tokens"] == ["towards"]
    eq = [c for c in chunks if c["op"] == "equal"][-1]
    assert eq["a_tokens"] == ["the", "Camera,"]


def test_diff_summary_delete_and_truncation():
    assert D.diff_summary("shot on 35mm at dusk", "shot at dusk") == "- on 35mm"
    a = "alpha bravo charlie delta echo foxtrot golf hotel"
    b = "alpha"
    assert D.diff_summary(a, b) == "- bravo charlie delta echo foxtrot…"


def test_diff_summary_caps_changes_with_n_more():
    a = "one two three four five six seven eight nine ten"
    b = "one 2 three 4 five 6 seven 8 nine 10"
    out = D.diff_summary(a, b, max_changes=3)
    assert out.count(D.ARROW) == 3
    assert out.endswith(", +2 more")


def test_diff_summary_identical_is_empty():
    assert D.diff_summary(CANON_A, CANON_A) == ""


def test_compare_bundle():
    out = D.compare(CANON_A, CANON_B)
    assert set(out) == {"score", "pct", "summary", "diff"}
    assert out["pct"] == 89
    assert out["summary"] == '“toward” → “towards”, + volumetric haze'
    assert out["diff"][0]["op"] == "equal"
