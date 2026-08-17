"""Tests for prompt_librarian.labels.

Free-standing like ``test_search``: plain dicts, no store, no ``folder_paths``.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from prompt_librarian import labels as L  # noqa: E402
from prompt_librarian import search as S  # noqa: E402


def rec(pid, body, tags=()):
    return {"id": pid, "body": body, "tags": list(tags)}


@pytest.fixture
def corpus():
    """Two near-identical bodies plus an outsider.

    The first two share every opening word, which is the case a body-head
    label cannot tell apart and a corpus-derived one can. All three carry the
    same tail of boilerplate, so there are more candidate terms than
    ``LABEL_TERMS`` and the corpus has to actually choose between them.
    """
    boiler = (", cinematic lighting, highly detailed, sharp focus, "
              "masterpiece quality, trending artstation")
    return [
        rec("ruined", "a lone ballerina drifting through a ruined theatre, "
                      "cracked marble columns, dust motes swirling, "
                      "volumetric haze, 35mm" + boiler, ["dance"]),
        rec("sunlit", "a lone ballerina drifting through a sunlit field, "
                      "tall summer grasses, pollen glinting, "
                      "volumetric haze, 35mm" + boiler, ["dance"]),
        rec("fruit", "a bowl of fruit on a wooden table, north light" + boiler),
    ]


def labels_of(corpus):
    return L.label_for_records(corpus)


# --------------------------------------------------------------------------
# The corpus half
# --------------------------------------------------------------------------


def test_shared_openings_get_different_labels(corpus):
    out = labels_of(corpus)
    assert out["ruined"] != out["sunlit"]
    assert "ruined theatre" in out["ruined"]
    assert "sunlit field" in out["sunlit"]


def test_a_term_the_whole_corpus_shares_loses_to_a_rare_one(corpus):
    """"ballerina" is in two of three bodies; "ruined" is in one."""
    out = labels_of(corpus)
    assert "ruined" in out["ruined"]
    assert "ballerina" not in out["ruined"]


def test_stopwords_and_short_words_never_appear(corpus):
    for label in labels_of(corpus).values():
        for term in label.split(L.LABEL_SEP):
            for word in term.split():
                assert word.casefold() not in L.STOPWORDS
                assert len(word) >= L.MIN_TERM_CHARS


def test_a_short_term_with_a_digit_survives_the_length_floor():
    """"8k" is two characters and is exactly the kind of thing that tells two
    otherwise identical prompts apart."""
    corpus = [rec("a", "a portrait of a woman in a red coat, 8k"),
              rec("b", "a portrait of a woman in a red coat, grainy film")]
    assert "8k" in labels_of(corpus)["a"]


def test_adjacent_picked_terms_are_one_phrase(corpus):
    label = labels_of(corpus)["ruined"]
    assert "ruined theatre" in label          # adjacent in the body: one phrase
    assert "ruined · theatre" not in label


def test_a_comma_ends_a_phrase():
    corpus = [rec("a", "neon rain, tokyo rooftops"),
              rec("b", "a completely unrelated still life of pears")]
    label = labels_of(corpus)["a"]
    assert "neon rain" in label
    assert "rain, tokyo" not in label


def test_label_order_follows_the_body_not_the_score():
    corpus = [rec("a", "alpha beta gamma delta"),
              rec("b", "alpha beta gamma epsilon"),
              rec("c", "something else entirely")]
    label = labels_of(corpus)["a"]
    terms = label.split(L.LABEL_SEP)
    assert terms == sorted(terms, key=lambda t: corpus[0]["body"].index(t))


# --------------------------------------------------------------------------
# The fallback half
# --------------------------------------------------------------------------


def test_no_corpus_means_the_body_head():
    body = "a lone ballerina drifting through a ruined theatre"
    assert L.label_for(body) == body
    assert L.label_for(body, None, 0) == body


def test_head_label_cuts_on_a_word_boundary_and_marks_the_cut():
    label = L.head_label("word " * 40)
    assert len(label) <= L.HEAD_CHARS + 1
    assert label.endswith(L.ELLIPSIS)
    assert not label.rstrip(L.ELLIPSIS).endswith(" ")


def test_head_label_collapses_whitespace():
    assert L.head_label("  first   line\n\nsecond line  ") == "first line second line"


def test_a_body_of_pure_stopwords_falls_back_to_its_head():
    corpus = [rec("a", "it is what it is"), rec("b", "and so on and so on")]
    assert labels_of(corpus)["a"] == "it is what it is"


def test_an_empty_body_has_no_label():
    """What an empty prompt should be *called* is the surface's question."""
    assert L.label_for("") == ""
    assert L.label_for("   ", lambda _t: 1, 3) == ""
    assert L.label_for(None) == ""


def test_a_one_record_library_still_gets_a_real_label():
    """Unsmoothed idf is 0.0 for a term in every document -- which in a library
    of one is every term, and the first prompt would never get a label."""
    out = labels_of([rec("only", "a lone ballerina in a ruined theatre")])
    assert out["only"] and out["only"] != ""


def test_the_label_is_capped():
    body = " ".join(f"distinctive{i}" for i in range(20))
    corpus = [rec("a", body), rec("b", "something else entirely")]
    assert len(labels_of(corpus)["a"]) <= L.LABEL_CHARS


def test_one_oversized_term_is_cut_rather_than_dropped():
    corpus = [rec("a", "x" * 200), rec("b", "something else entirely")]
    label = labels_of(corpus)["a"]
    assert label and len(label) <= L.LABEL_CHARS + 1


# --------------------------------------------------------------------------
# Document frequency, and the index that supplies it
# --------------------------------------------------------------------------


def test_document_frequency_counts_documents_not_occurrences():
    df, ndocs = L.document_frequency([
        rec("a", "haze haze haze"),
        rec("b", "haze"),
        rec("c", "fruit", ["haze"]),      # tags count too
    ])
    assert ndocs == 3
    assert df["haze"] == 3
    assert df["fruit"] == 1


@pytest.mark.parametrize("word", ["Straße", "İstanbul", "München", "35MM",
                                  "Ballerina", "café", "猫の写真"])
def test_term_tokens_folds_exactly_like_the_search_index(word):
    """The two have to agree token for token or every df lookup would miss."""
    assert list(L.term_tokens(word)) == S.tokenize(word)


def test_a_word_that_splits_is_scored_by_its_rarest_piece():
    """Turkish dotted I decomposes, so "İstanbul" is posted as i + stanbul.

    Looked up whole it would find nothing; looked up by its commonest piece
    ("i") it would look like boilerplate. The rarest piece is what carries the
    distinguishing power, so that is what decides.
    """
    corpus = [rec("a", "a rooftop in İstanbul at night"),
              rec("b", "a rooftop in a city at night, i think")]
    assert "stanbul" in L.term_tokens("İstanbul")
    assert "İstanbul" in labels_of(corpus)["a"]     # the surface form is kept


def test_the_index_supplies_the_frequencies_labels_look_up():
    idx = S.build_index([rec("a", "Straße bei Nacht in München")], rev=1)
    assert idx.df(L.term_tokens("STRASSE")[0]) == 1
    assert idx.df(L.term_tokens("München")[0]) == 1
    assert idx.df("nothing-like-it") == 0


def test_the_index_labels_from_its_own_postings(corpus):
    idx = S.build_index(corpus, rev=1)
    assert idx.label_of("ruined") == labels_of(corpus)["ruined"]
    # ...and any text at all, against the same corpus (a version body, a draft)
    assert "sunlit field" in idx.label_for(corpus[1]["body"])


def test_index_labels_are_cached_but_dropped_on_a_write(corpus):
    idx = S.build_index(corpus, rev=1)
    before = idx.label_of("ruined")
    assert idx._labels                                  # memoized
    idx.add(rec("more", "another ruined theatre, and one more ruined stage"))
    assert not idx._labels                              # the corpus moved
    # "ruined"/"theatre" are no longer this record's alone, so the label moves.
    assert idx.label_of("ruined") != before


def test_removing_a_record_also_drops_the_labels(corpus):
    idx = S.build_index(corpus, rev=1)
    idx.label_of("ruined")
    idx.remove("sunlit")
    assert not idx._labels


def test_labels_survive_junk_records():
    assert L.label_for_records(None) == {}
    assert L.label_for_records(["not a record", None]) == {}
    assert L.document_frequency(None) == ({}, 0)
