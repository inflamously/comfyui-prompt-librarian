"""Text helpers search uses; the implementations live in ``shared/text.py``."""

from __future__ import annotations

import re

from ...shared.text import excerpt as preview
from ...shared.text import normalize, tokenize
from ...shared.text import within_edit_1 as _within_edit_1

_WS_RE = re.compile(r"\s+", re.UNICODE)

__all__ = ["_WS_RE", "_within_edit_1", "normalize", "preview", "tokenize"]
