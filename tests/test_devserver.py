"""High-level dev-server use cases; detailed behavior lives in feature tests."""

import asyncio
import subprocess
import sys
from functools import partial
from pathlib import Path

import pytest

_BODY = "smokecheck lighthouse surrounded by turquoise waves"


@pytest.fixture
def smoke(tmp_path):
    """Run each use case through real startup with its own process and library."""

    def run(case):
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                case,
                "--seed",
                "1",
                "--allow-outside",
                "--library",
                str(tmp_path / "scratch" / "library.sqlite3"),
            ],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert f"{case} smoke OK" in result.stdout

    return run


def test_open_playground(smoke):
    smoke("playground")


def test_save_and_find_prompt(smoke):
    smoke("save_and_find")


def test_edit_prompt_and_view_history(smoke):
    smoke("edit_and_history")


def test_delete_prompt(smoke):
    smoke("delete")


def test_bulk_tag_prompts(smoke):
    smoke("bulk_tags")


def test_find_duplicates_and_compare(smoke):
    smoke("duplicates_and_compare")


def test_resolve_snippet_and_wildcard(smoke):
    smoke("resolve")


def test_change_settings(smoke):
    smoke("settings")


def test_export_and_restore_library(smoke):
    smoke("export_and_restore")


async def _api(client, path, *, body=None, **params):
    method = "GET" if body is None else "POST"
    async with client.request(
        method, "/api/prompt_librarian" + path, params=params, json=body
    ) as response:
        text = await response.text()
        assert response.status == 200, f"{method} {path}: {response.status} {text}"
        return await response.json()


async def _create_prompt(api):
    created = await api("/create", body={"body": _BODY, "tags": ["smokecheck"]})
    return created["prompt"]["id"]


async def _playground(client, api):
    async with client.get("/") as response:
        assert response.status == 200
        assert "window.__DEV__" in await response.text()
    async with client.get(
        "/extensions/comfyui-prompt-library/prompt_librarian/index.js"
    ) as response:
        assert response.status == 200
        assert "javascript" in response.content_type
    assert (await api("/ping"))["count"] == 1
    assert (await api("/search"))["hits"]


async def _save_and_find(client, api):
    pid = await _create_prompt(api)
    found = await api("/search", q="smokecheck")
    assert found["hits"][0]["id"] == pid
    assert found["hits"][0]["label"]
    assert pid in (await api("/meta", body={"ids": [pid]}))["meta"]
    completion = await api("/autocomplete", word_prefix="smoke", phrase_prefix="smoke")
    assert completion["suggestions"][0] == {
        "text": "smokecheck", "scope": "word", "source_count": 1,
    }


async def _edit_and_history(client, api):
    pid = await _create_prompt(api)
    await api("/update", body={"id": pid, "body": _BODY + " at dusk"})
    assert (await api("/prompt", id=pid))["prompt"]["body"].endswith("at dusk")
    assert (await api("/versions", id=pid))["versions"]


async def _delete(client, api):
    pid = await _create_prompt(api)
    assert (await api("/delete", body={"id": pid}))["deleted"]
    assert (await api("/search", q="smokecheck"))["total"] == 0


async def _bulk_tags(client, api):
    pid = await _create_prompt(api)
    assert (await api("/bulk/retag", body={"ids": [pid], "add": ["reviewed"]}))["count"] == 1
    assert "reviewed" in {tag["tag"] for tag in (await api("/taxonomy"))["tags"]}


async def _duplicates_and_compare(client, api):
    await _create_prompt(api)
    assert (await api("/dupes", body={"text": _BODY}))["matches"]
    assert "groups" in await api("/dupes/all")
    comparison = await api("/compare", body={"a_text": _BODY, "b_text": _BODY + " at dusk"})
    assert comparison["diff"]


async def _resolve(client, api):
    await api("/snippet", body={"name": "smokecheck", "body": "synthetic style"})
    assert "smokecheck" in (await api("/snippets"))["snippets"]
    wildcard = (await api("/wildcards"))["names"][0]
    resolved = await api("/resolve", body={"text": f"[[smokecheck]] __{wildcard}__"})
    assert resolved["text"].startswith("synthetic style ")
    assert not resolved["missing"]


async def _settings(client, api):
    settings = await api("/settings", body={"dupe_threshold": 0.85})
    assert settings["settings"]["dupe_threshold"] == 0.85


async def _export_and_restore(client, api):
    pid = await _create_prompt(api)
    exported = (await api("/export"))["library"]
    assert any(prompt["id"] == pid for prompt in exported["prompts"])
    await api("/delete", body={"id": pid})
    assert (await api("/search", q="smokecheck"))["total"] == 0
    await api("/import", body={"library": exported, "replace": True})
    assert (await api("/search", q="smokecheck"))["total"] == 1


_CASES = {
    "playground": _playground,
    "save_and_find": _save_and_find,
    "edit_and_history": _edit_and_history,
    "delete": _delete,
    "bulk_tags": _bulk_tags,
    "duplicates_and_compare": _duplicates_and_compare,
    "resolve": _resolve,
    "settings": _settings,
    "export_and_restore": _export_and_restore,
}


async def _smoke_case(app, case):
    from aiohttp.test_utils import TestClient, TestServer

    async with TestClient(TestServer(app)) as client:
        await _CASES[case](client, partial(_api, client))


def _run_smoke():
    from aiohttp import web

    # Startup still owns stubbing, repointing, seeding, and app construction.
    # Only replace the blocking listener with an ephemeral loopback test server.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from scripts.devserver import main

    case = sys.argv[1]

    def run_app(app, **kwargs):
        asyncio.run(_smoke_case(app, case))

    web.run_app = run_app
    assert main(sys.argv[2:]) == 0
    print(f"[devserver] {case} smoke OK")


if __name__ == "__main__":
    _run_smoke()
