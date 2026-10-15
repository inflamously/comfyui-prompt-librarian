"""Composition root: opens the library and wires projectors, cache upkeep and broadcast."""

import os
import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from .features import dupes, search, wildcards, word_images
from .features.autocomplete import vocabulary
from .features.autocomplete.keywords import list_keywords
from .features.library import ignored, snippets
from .features.prompts.get import count_prompts, get_prompts
from .features.storage import compact as storage_compact
from .features.storage import health, migrate
from .shared.events import EVENT_CHANGED, EVENT_USED, Change
from .shared.library import Library
from .shared.paths import database_path


@dataclass
class App:
    """An open library and the read-side sources built on it."""

    lib: Library
    search_source: search.LibrarySearchSource
    dupe_source: dupes.LibraryDupeSource
    migrate_from: object = None


def build(path: str | None = None, migrate_from: object = None) -> App:
    """Open the library at ``path`` (ComfyUI's user directory by default) and wire it."""
    lib = Library(path or database_path())
    lib.extend(setup=vocabulary.initialize, projector=vocabulary.project)
    lib.extend(projector=ignored.forget_deleted)
    dupe_source = dupes.LibraryDupeSource(lib)
    lib.events.subscribe(search.on_change)
    lib.events.subscribe(dupes.patcher(dupe_source))
    lib.events.subscribe(_broadcast)
    return App(lib, search.LibrarySearchSource(lib), dupe_source, migrate_from)


_lock = threading.Lock()
_current: App | None = None


def current() -> App:
    """The app routes and the node use; built on first use, never at import."""
    # ComfyUI sets its user directory after importing nodes, so the path resolves lazily.
    global _current
    with _lock:
        if _current is None:
            _current = _install(build())
        return _current


def use(app: App | None) -> App | None:
    """Make ``app`` current (tests and the dev tool); returns the previous one."""
    global _current
    with _lock:
        previous, _current = _current, (_install(app) if app is not None else None)
        return previous


def _install(app: App) -> App:
    wildcards.configure(
        root=lambda: _wildcards_dir(app), snippets=lambda: snippets.list_snippets(app.lib)
    )
    return app


def _wildcards_dir(app: App) -> str:
    return os.path.join(os.path.dirname(app.lib.path), "wildcards")


def word_images_dir(app: App) -> str:
    """Where word pictures live: a ``word-images`` directory beside the library."""
    return os.path.join(os.path.dirname(app.lib.path), "word-images")


def word_picture_candidates(app: App, limit: int = 500) -> tuple[list[str], int]:
    """Vocabulary words worth a generated picture: used, not filler, none yet."""
    return word_images.picture_candidates(word_images_dir(app), list_keywords(app.lib), limit)


def dictionary_dir(app: App) -> str:
    """Where the downloaded dictionary lives: a ``dictionary`` directory beside the library."""
    return os.path.join(os.path.dirname(app.lib.path), "dictionary")


def gallery_words(app: App, limit: int = 2000) -> tuple[list[dict[str, object]], int]:
    """The vocabulary minus filler, most used first, with pictures; returns ``(words, total)``."""
    pictures = word_images.list_word_images(word_images_dir(app))
    seen: set[str] = set()
    words = []
    for text, uses in list_keywords(app.lib):
        key = " ".join(text.split()).lower()
        if key in seen or word_images.is_filler(key):
            continue
        seen.add(key)
        words.append({"word": text, "uses": uses, "picture": pictures.get(key)})
    return words[:limit], len(words)


def legacy_sources(app: App) -> list[str]:
    """Legacy JSON/JSONL files beside the library that this app may migrate."""
    return migrate.legacy_sources(app.lib.path, app.migrate_from)


def storage_status(app: App) -> dict[str, object]:
    """What the storage panel shows."""
    return health.storage_status(app.lib, legacy_sources(app))


def compact(app: App) -> dict[str, object]:
    """VACUUM on request; bytes before and after, and the record count."""
    before, after = storage_compact.compact(app.lib)
    return {"before": before, "after": after, "records": count_prompts(app.lib)}


def migrate_legacy(app: App, path: str | None = None) -> dict[str, object]:
    """Merge one named legacy file, or every pending one beside the library."""
    if path is not None:
        return migrate.migrate_legacy(app.lib, path)
    return migrate.migrate_pending(app.lib, legacy_sources(app))



def search_prompts(
    app: App,
    query: str = "",
    *,
    tags: Iterable[str] = (),
    dupes_only: bool = False,
    grouped: bool = False,
    sort: str = "relevance",
    mode: str = "all",
    offset: int = 0,
    limit: int = 50,
    threshold: float = dupes.DEFAULT_THRESHOLD,
    match_id: str = "",
    all_pairs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Search with near-duplicate facts filled in: the one place search meets dupes."""
    rev = app.search_source.revision()
    ids, groups = None, None
    if dupes_only or grouped:
        scan = all_pairs or dupes.dupe_counts(app.dupe_source, threshold, rev=rev)
        ids = dupes.dupe_ids(scan) if dupes_only else None
        groups = (scan.get("groups") or []) if grouped else None

    def _counts(pids: list[str]) -> dict[str, int]:
        return dupes.page_dupe_counts(app.dupe_source, pids, threshold, rev=rev)

    return search.search(
        app.search_source, query,
        tags=tags, dupes_only=dupes_only,
        sort=sort, mode=mode, offset=offset, limit=limit,
        threshold=threshold, rev=rev, dupe_ids=ids,
        dupe_count_fn=_counts, match_fn=_match_fn(app, match_id, threshold, rev), groups=groups,
    )


def _match_fn(
    app: App, match_id: str, threshold: float, rev: int
) -> Callable[[list[str]], dict[str, float]] | None:
    if not match_id:
        return None

    def _matches(pids: list[str]) -> dict[str, float]:
        hits = dupes.find_similar(app.dupe_source, pid=match_id, exclude_id=match_id,
                                  threshold=threshold, limit=0, with_summary=False, rev=rev)
        table = {hit["id"]: hit["score"] for hit in hits}
        return {pid: table[pid] for pid in pids if pid in table}

    return _matches


def similar_prompts(
    app: App,
    *,
    text: str | None = None,
    pid: str | None = None,
    exclude_id: str | None = None,
    threshold: float = dupes.DEFAULT_THRESHOLD,
    limit: int = 10,
    with_summary: bool = True,
    ignored: Iterable[Any] = (),
) -> list[dict[str, Any]]:
    """:func:`dupes.find_similar` against the library, each match with its label."""
    matches = dupes.find_similar(
        app.dupe_source, text=text, pid=pid, exclude_id=exclude_id, threshold=threshold,
        limit=limit, with_summary=with_summary, ignored=ignored,
        rev=app.search_source.revision(),
    )
    records = get_prompts(app.lib, [m["id"] for m in matches])
    index = search.labeller(app.search_source, records.values())
    # Label copies: the matches may be cached, and a label belongs to one corpus.
    return [{**m, "label": index.label_of(m["id"])} for m in matches]


def prompt_meta(app: App, ids: list[str], threshold: float) -> dict[str, dict[str, Any]]:
    """What a node face shows for each id that exists: label, counters, tags, dupes."""
    records = get_prompts(app.lib, ids)
    counts = dupes.page_dupe_counts(app.dupe_source, list(records), threshold,
                                    rev=app.search_source.revision())
    index = search.labeller(app.search_source, records.values())
    return {
        pid: {
            "label": index.label_of(pid),
            "rating": int(rec.get("rating", 0) or 0),
            "used": int(rec.get("used", 0) or 0),
            "tags": list(rec.get("tags") or ()),
            "near_dupes": int(counts.get(pid, 0) or 0),
            "updated": rec.get("updated", ""),
        }
        for pid, rec in records.items()
    }

def _notify(event: str, payload: dict[str, object]) -> None:
    """Best-effort websocket push; the library never depends on the server."""
    try:
        from server import PromptServer  # noqa: PLC0415 - absent outside ComfyUI

        PromptServer.instance.send_sync(event, payload)
    except Exception:
        pass


def _broadcast(change: Change) -> None:
    if change.op == "usage" and change.ids:
        pid = change.ids[0]
        used = (change.records.get(pid) or {}).get("used", 0)
        _notify(EVENT_USED, {"id": pid, "used": used, "rev": change.new_rev})
    _notify(EVENT_CHANGED, {"op": change.op, "ids": list(change.ids), "rev": change.new_rev})
