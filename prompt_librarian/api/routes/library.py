"""Offload expensive work and stream file transfers in bounded batches."""

import contextlib
import os
import tempfile

from ... import app
from ...features.library.settings import update_settings
from ...features.storage.export import export_library
from ...features.storage.export_stream import (
    EXPORT_BATCH,
    EXPORT_TAIL,
    export_head,
    export_records,
)
from ...features.storage.health import library_facts
from ...features.storage.importing import import_library, import_library_file
from .. import schemas
from ..config import CAPABILITIES
from ..utils import (
    _body,
    _bool,
    _get_web,
    _json,
    _lib,
    _offload,
    _opt,
    _query,
    _route,
    _str,
    _threshold,
)

_UPLOAD_CHUNK = 1 << 20


def _remove_upload(path):
    with contextlib.suppress(FileNotFoundError):
        os.unlink(path)


async def _spool_upload(request):
    """Copy the multipart ``library`` field to an OS temp file in chunks."""
    try:
        reader = await request.multipart()
    except Exception as exc:
        raise ValueError("expected a multipart upload") from exc

    path = ""
    found = False
    try:
        with tempfile.NamedTemporaryFile(
            mode="w+b",
            prefix="prompt-librarian-import-",
            suffix=".json",
            delete=False,
        ) as handle:
            path = handle.name
            while True:
                field = await reader.next()
                if field is None:
                    break
                if field.name != "library":
                    await field.release()
                    continue
                if found:
                    raise ValueError("multipart upload contains more than one library file")
                found = True
                while True:
                    chunk = await field.read_chunk(size=_UPLOAD_CHUNK)
                    if not chunk:
                        break
                    handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if not found:
            raise ValueError("multipart upload is missing the library field")
        return path
    except Exception:
        if path:
            _remove_upload(path)
        raise


def _storage_status():
    return app.storage_status(app.current())


def _ping_status():
    return {
        "ok": True,
        **library_facts(_lib()),
        "threshold": _threshold(None),
        "capabilities": dict(CAPABILITIES),
        "storage": _storage_status(),
    }


@_route("get", "/ping", op="ping",
        summary="Store facts the panel boots from: schema, count, flags, capabilities.",
        returns=schemas.PingResponse)
async def ping(request):
    return _json(await _offload(_ping_status))


@_route("get", "/storage", op="getStorage",
        summary="SQLite health, legacy migration and space-reclamation facts.",
        returns=schemas.StorageResponse)
async def storage(request):
    return _json({"storage": await _offload(_storage_status)})


@_route("post", "/storage/migrate", op="migrateLegacyLibrary",
        summary="Explicitly merge a legacy JSONL/JSON library into SQLite.",
        returns=schemas.MigrateStorageResponse)
async def migrate_storage(request):
    result = await _offload(app.migrate_legacy, app.current())
    return _json({**result, "storage": await _offload(_storage_status)})


@_route("post", "/storage/compact", op="compactPromptLibrary",
        summary="Run explicit storage optimization (SQLite VACUUM).",
        returns=schemas.CompactStorageResponse)
async def compact_storage(request):
    result = await _offload(app.compact, app.current())
    return _json({**result, "storage": await _offload(_storage_status)})


@_route("get", "/export", op="exportLibrary",
        summary="The whole library envelope, ready to write to a file.",
        returns=schemas.ExportResponse)
async def export(request):
    return _json({"library": await _offload(export_library, _lib())})


@_route("get", "/export/file", op="exportLibraryFile",
        summary="Stream the portable schema-1 JSON library as a download.",
        returns=schemas.ExportResponse)
async def export_file(request):
    """Stream JSON without calling ``export_raw`` or holding all prompts."""
    head, ids = await _offload(export_head, _lib())

    response = _get_web().StreamResponse(headers={
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="prompt-library.json"',
        "Cache-Control": "no-store",
    })
    await response.prepare(request)
    await response.write(head)
    first = True
    for start in range(0, len(ids), EXPORT_BATCH):
        encoded = await _offload(export_records, _lib(), ids[start:start + EXPORT_BATCH])
        for record in encoded:
            if not first:
                await response.write(b",")
            await response.write(record)
            first = False
    await response.write(EXPORT_TAIL)
    await response.write_eof()
    return response


@_route("post", "/settings", op="updateSettings",
        body=schemas.SettingsBody, returns=schemas.SettingsResponse)
async def settings(request):
    """Persist the dupe threshold / version cap the panel exposes."""
    data = await _body(request)
    return _json({"settings": await _offload(
        update_settings,
        _lib(),
        _opt(data, "dupe_threshold"),
        _opt(data, "version_cap"),
    )})


@_route("post", "/import", op="importLibrary",
        summary="Import an envelope.",
        body=schemas.ImportBody, returns=schemas.ImportResponse)
async def import_route(request):
    data = await _body(request)
    raw = data.get("library", data.get("raw"))
    replace = _bool(data.get("replace"), True)
    return _json({"count": await _offload(import_library, _lib(), raw, replace)})


@_route("post", "/import/file", op="importLibraryFile",
        summary="Upload a portable JSON library without buffering it in the browser.",
        query=schemas.ImportFileQuery, returns=schemas.ImportResponse)
async def import_file(request):
    mode = _str(_query(request).get("mode"), "merge").strip().lower()
    if mode not in ("merge", "replace"):
        raise ValueError("mode must be merge or replace")
    path = await _spool_upload(request)
    try:
        count = await _offload(import_library_file, _lib(), path, mode == "replace")
    finally:
        await _offload(_remove_upload, path)
    return _json({"count": count})
