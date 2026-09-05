"""The library's one clock and one id source.

Every timestamp and every new id comes from here, so a harness can pin both
(``scripts/devkit/sim.py`` does, to make runs deterministic).
"""

import uuid
from datetime import datetime, timezone


def now_iso() -> str:
    """Current UTC time, second precision, with a literal ``Z`` so stamps sort as text."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def new_id() -> str:
    """A fresh stable record id; identical prompt bodies may coexist."""
    return uuid.uuid4().hex
