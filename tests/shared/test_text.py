"""Normalization, the two previews, and the edit-distance check."""

import pytest

from prompt_librarian.shared import text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, ""),
        ("", ""),
        ("Straße", "strasse"),
        ("  Hello,   World!! ", "hello world"),
        ("snake_case stays", "snake_case stays"),
        ("東京 夜景", "東京 夜景"),
        ("ﬁne", "fine"),
        (42, "42"),
    ],
)
def test_normalize(raw, expected):
    assert text.normalize(raw) == expected


def test_tokenize_splits_the_normalized_form():
    assert text.tokenize("A-b  c") == ["a", "b", "c"]
    assert text.tokenize("") == []


def test_preview_of_collapses_all_whitespace_and_hard_cuts():
    assert text.preview_of("a\n\tb   c", chars=4) == "a b "
    assert text.preview_of(None) == ""


def test_excerpt_keeps_spacing_and_marks_a_cut():
    assert text.excerpt("a\r\nb  c") == "a b  c"
    assert text.excerpt("abcdef", limit=3) == "abc…"
    assert text.excerpt("") == ""


@pytest.mark.parametrize(
    ("a", "b", "close"),
    [
        ("boat", "boat", True),
        ("boat", "bost", True),
        ("boat", "boats", True),
        ("boats", "boat", True),
        ("boat", "bot", True),
        ("boat", "bots", False),
        ("boat", "boaters", False),
        ("", "a", True),
    ],
)
def test_within_edit_1(a, b, close):
    assert text.within_edit_1(a, b) is close
