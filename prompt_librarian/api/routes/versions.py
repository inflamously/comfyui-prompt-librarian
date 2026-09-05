"""List previews only; fetch full version bodies on demand to bound responses."""

from ...features.prompts import versions as prompt_versions
from .. import schemas
from ..utils import (
    _body,
    _int,
    _json,
    _labelled,
    _labeller,
    _lib,
    _offload,
    _query,
    _route,
    _str,
)


@_route("get", "/versions", op="listVersions",
        summary="Version history of one record as previews, never full bodies.",
        query=schemas.ListVersionsQuery, returns=schemas.VersionsResponse)
async def versions(request):
    params = _query(request)
    pid = _str(params.get("id"))
    chars = _int(params.get("chars"), 160)
    # Label history against the current corpus.
    label_fn = _labeller().label_for
    previews = prompt_versions.version_previews(_lib(), pid, chars, label_fn)
    return _json({"id": pid, "versions": previews})


@_route("get", "/version", op="getVersion",
        summary="One full version entry by index.",
        query=schemas.GetVersionQuery, returns=schemas.VersionResponse)
async def version(request):
    params = _query(request)
    pid = _str(params.get("id"))
    index = _int(params.get("index"), -1)
    entry = prompt_versions.get_version(_lib(), pid, index)
    return _json({"id": pid, "index": index, "version": entry})


@_route("post", "/versions/restore", op="restoreVersion",
        summary="Restore a version onto the record; the current body is snapshotted first.",
        body=schemas.RestoreVersionBody, returns=schemas.PromptResponse)
async def versions_restore(request):
    data = await _body(request)
    pid = _str(data.get("id"))
    index = _int(data.get("index"), -1)
    # Snapshots the current body first, so the restore is itself undoable.
    def _work():
        return _labelled(prompt_versions.restore_version(_lib(), pid, index))

    return _json(await _offload(_work))
