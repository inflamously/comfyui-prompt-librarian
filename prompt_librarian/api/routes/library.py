"""Store-wide facts and whole-library moves.

``/ping`` is the first request the panel makes and decides what it builds;
``/export`` and ``/import`` are the whole envelope in and out; ``/settings``
persists the two knobs the panel exposes. Everything except ping serialises or
rewrites every record, so everything except ping is offloaded.
"""

from ...store import SCHEMA_VERSION, STORE
from .. import schemas
from ..config import CAPABILITIES
from ..utils import _body, _bool, _json, _offload, _opt, _route, _threshold


@_route("get", "/ping", op="ping",
        summary="Store facts the panel boots from: schema, count, flags, capabilities.",
        returns=schemas.PingResponse)
async def ping(request):
    return _json({
        "ok": True,
        "schema": SCHEMA_VERSION,
        "count": STORE.count(),
        "path": STORE.store_path(),
        "corrupt": STORE.is_corrupt(),
        "readonly": STORE.is_readonly(),
        "threshold": _threshold(None),
        "capabilities": dict(CAPABILITIES),
    })


@_route("get", "/export", op="exportLibrary",
        summary="The whole library envelope, ready to write to a file.",
        returns=schemas.ExportResponse)
async def export(request):
    return _json({"library": await _offload(STORE.export_raw)})


@_route("post", "/settings", op="updateSettings",
        body=schemas.SettingsBody, returns=schemas.SettingsResponse)
async def settings(request):
    """Persist the dupe threshold / version cap the panel exposes."""
    data = await _body(request)
    return _json({"settings": await _offload(
        STORE.set_settings,
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
    return _json({"count": await _offload(STORE.import_raw, raw, replace)})
