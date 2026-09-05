"""The one clock and id source."""

import re

from prompt_librarian.shared import clock


def test_now_iso_is_second_precision_utc_with_z():
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", clock.now_iso())


def test_new_id_is_unique_hex():
    ids = {clock.new_id() for _ in range(100)}
    assert len(ids) == 100
    assert all(re.fullmatch(r"[0-9a-f]{32}", pid) for pid in ids)
