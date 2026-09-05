"""Merging a legacy JSON/JSONL library into SQLite, once per source file version."""

import hashlib
import os

from ...shared import entries, meta
from ...shared.clock import now_iso
from ...shared.errors import NotFoundError
from ...shared.library import Library, Write
from ...shared.records import Record
from .legacy import read_legacy, same_record


def legacy_sources(library_path: str, migrate_from: object = None) -> list[str]:
    """Existing legacy files beside the library, or the one given; never a scan.

    ``migrate_from=False`` disables migration; a path names the only source.
    """
    if migrate_from is False:
        return []
    if isinstance(migrate_from, (str, os.PathLike)):
        source = os.fspath(migrate_from)
        return [source] if os.path.isfile(source) else []
    base = os.path.splitext(library_path)[0]
    return [path for path in (base + ".jsonl", base + ".json") if os.path.isfile(path)]


def fingerprint(source: str) -> str:
    """Identifies one version of a source file: path, size and modification time."""
    stat = os.stat(source)
    return hashlib.sha256(
        f"{os.path.abspath(source)}:{stat.st_size}:{stat.st_mtime_ns}".encode()
    ).hexdigest()


def pending_sources(lib: Library, sources: list[str]) -> list[str]:
    """The sources whose current version has not been migrated yet."""
    done = meta.load(lib).get("migrations") or {}
    return [source for source in sources if fingerprint(source) not in done]


def migrate_legacy(lib: Library, source: str) -> dict[str, object]:
    """Merge one legacy library; the source file is left unchanged.

    Colliding ids with different content get a deterministic derived id; the
    envelope's snippets and muted pairs are unioned. Returns the counts.

    Raises:
        NotFoundError: ``source`` is not a file.
    """
    if not source or not os.path.isfile(source):
        raise NotFoundError(f"no legacy library at {source}")
    print_ = fingerprint(source)
    incoming, unreadable = read_legacy(source)
    with meta.edit(lib, "import") as (work, stored):
        migrations = dict(stored.get("migrations") or {})
        if print_ in migrations:
            work.skip = True
            skipped = len(incoming["prompts"]) + unreadable
            return {"imported": 0, "skipped": skipped, "collisions": 0, "already_migrated": True}
        for name, entry in incoming["snippets"].items():
            stored["snippets"].setdefault(name, entry)
        stored["ignored"] += [p for p in incoming["ignored"] if p not in stored["ignored"]]
        imported, skipped, collisions = _merge_records(work, incoming["prompts"], print_)
        migrations[print_] = {"source": os.path.basename(source), "updated": now_iso()}
        stored["migrations"] = migrations
    return {
        "imported": imported,
        "skipped": skipped + unreadable,
        "collisions": collisions,
        "already_migrated": False,
    }


def _merge_records(work: Write, prompts: list[Record], print_: str) -> tuple[int, int, int]:
    imported = skipped = collisions = 0
    for rec in (dict(item) for item in prompts):
        current = entries.get(work.con, rec["id"])
        if current is not None:
            if same_record(current, rec):
                skipped += 1
                continue
            collisions += 1
            rec["id"] = _free_id(work, rec, print_)
            if rec["id"] is None:
                skipped += 1
                continue
        entries.put(work, rec)
        imported += 1
    return imported, skipped, collisions


def _free_id(work: Write, rec: Record, print_: str) -> str | None:
    """A deterministic id for a colliding record, or ``None`` when it is already in."""
    original, attempt = rec["id"], 0
    while True:
        suffix = f":{attempt}" if attempt else ""
        candidate = hashlib.md5(  # noqa: S324 - deterministic id only
            f"{print_}:{original}{suffix}".encode()
        ).hexdigest()
        existing = entries.get(work.con, candidate)
        if existing is None:
            return candidate
        if same_record(existing, {**rec, "id": candidate}):
            return None
        attempt += 1


def migrate_pending(lib: Library, sources: list[str]) -> dict[str, object]:
    """Migrate every pending source (or re-report the first one); counts are summed.

    Raises:
        NotFoundError: There is no legacy source at all.
    """
    pending = pending_sources(lib, sources)
    if len(pending) > 1:
        results = [migrate_legacy(lib, source) for source in pending]
        return {
            "imported": sum(result["imported"] for result in results),
            "skipped": sum(result["skipped"] for result in results),
            "collisions": sum(result["collisions"] for result in results),
            "already_migrated": all(result["already_migrated"] for result in results),
        }
    source = pending[0] if pending else (sources[0] if sources else None)
    if source is None:
        raise NotFoundError(f"no legacy library beside {lib.path}")
    return migrate_legacy(lib, source)
