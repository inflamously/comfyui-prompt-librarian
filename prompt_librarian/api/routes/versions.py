"""List previews only; fetch full version bodies on demand to bound responses."""

from ...store import STORE
from .. import schemas
from ..utils import _body, _int, _json, _labelled, _labeller, _offload, _query, _route, _str


@_route("get", "/versions", op="listVersions",
        summary="Version history of one record as previews, never full bodies.",
        query=schemas.ListVersionsQuery, returns=schemas.VersionsResponse)
async def versions(request):
    params = _query(request)
    pid = _str(params.get("id"))
    chars = _int(params.get("chars"), 160)
    # Label history against the current corpus.
    label_fn = _labeller().label_for
    return _json({"id": pid, "versions": STORE.version_previews(pid, chars, label_fn)})


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
    return _json(await _offload(lambda: _labelled(STORE.restore_version(pid, index))))
