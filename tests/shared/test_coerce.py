"""Tolerant scalar coercion."""

import pytest

from prompt_librarian.shared.coerce import as_int, as_str, clamp


@pytest.mark.parametrize(("raw", "out"), [(None, ""), ("a", "a"), (3, "3")])
def test_as_str(raw, out):
    assert as_str(raw) == out


@pytest.mark.parametrize(("raw", "out"), [(True, 1), (4, 4), ("4.9", 4), ("x", 0), (None, 0)])
def test_as_int(raw, out):
    assert as_int(raw) == out


def test_clamp():
    assert [clamp(v, 0, 5) for v in (-1, 3, 9)] == [0, 3, 5]
