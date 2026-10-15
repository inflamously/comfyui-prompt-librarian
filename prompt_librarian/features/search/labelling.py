"""Display labels for records, consistent with the ones search results carry."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .cache import get_index
from .index import SearchIndex
from .source import LibrarySearchSource


def labeller(
    source: LibrarySearchSource, records: Iterable[dict[str, Any]] | None = None
) -> SearchIndex:
    """An index whose ``label_of``/``label_for`` match the library's search labels."""
    if records is None:
        return get_index(source)
    return SearchIndex(
        list(records), rev=source.revision(), corpus=source.corpus_stats(), df_fn=source.term_df,
    )


def labelled(source: LibrarySearchSource, rec: dict[str, Any] | None) -> dict[str, Any]:
    """``{"prompt": rec, "label": ...}``; call in the executor hop, it may rebuild the index."""
    if not rec:
        return {"prompt": rec, "label": ""}
    return {"prompt": rec, "label": labeller(source, [rec]).label_of(str(rec.get("id") or ""))}
