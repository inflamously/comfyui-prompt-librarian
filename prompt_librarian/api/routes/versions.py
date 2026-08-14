"""Version history: list the previews, read one entry, restore one entry.

The list never carries bodies. A record sitting at the 50-version cap would
otherwise be a multi-megabyte response on every selection change, so the panel
pages through previews and asks for a full entry only when one is opened.
"""

from ...store import STORE
from .. import schemas
from ..utils import _body, _int, _json, _offload, _query, _route, _str


@_route("get", "/versions", op="listVersions",
        summary="Version history of one record as previews, never full bodies.",
        query=schemas.ListVersionsQuery, returns=schemas.VersionsResponse)
async def versions(request):
    params = _query(request)
    pid = _str(params.get("id"))
    chars = _int(params.get("chars"), 160)
    # Previews only: a record at the 50-version cap would otherwise be a
    # multi-megabyte response on every selection change.
    return _json({"id": pid, "versions": STORE.version_previews(pid, chars)})


@_route("get", "/version", op="getVersion",
        summary="One full version entry by index.",
        query=schemas.GetVersionQuery, returns=schemas.VersionResponse)
async def version(request):
    params = _query(request)
    pid = _str(params.get("id"))
    index = _int(params.get("index"), -1)
    return _json({"id": pid, "index": index, "version": STORE.version(pid, index)})


@_route("post", "/versions/restore", op="restoreVersion",
        summary="Restore a version onto the record; the current body is snapshotted first.",
        body=schemas.RestoreVersionBody, returns=schemas.PromptResponse)
async def versions_restore(request):
    data = await _body(request)
    pid = _str(data.get("id"))
    index = _int(data.get("index"), -1)
    # Snapshots the current body first, so the restore is itself undoable.
    return _json({"prompt": await _offload(STORE.restore_version, pid, index)})
