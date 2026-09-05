"""User flows the sim replays against the real routes.

A scenario sees only what outlives the backend migration: the HTTP API, the
node's ``run()`` entry point, and the library file's path. It never touches the
store object. It returns a JSON-able outcome, which must stay identical across
runs, and wraps the interesting work in ``ctx.step(label)`` so the sim can
record SQLite connections and time per step.
"""

import sqlite3
import threading
import time

_BODY = "smokecheck lighthouse surrounded by turquoise waves"
_TWIN = "smokecheck lighthouse surrounded by turquoise wave"

SCENARIOS = {}


def scenario(seed=1):
    """Register ``fn(ctx)`` as a scenario on a library seeded with ``seed`` prompts."""

    def deco(fn):
        SCENARIOS[fn.__name__] = (seed, fn)
        return fn

    return deco


async def _create(ctx, body=_BODY, tags=("smokecheck",)):
    return (await ctx.api("/create", body={"body": body, "tags": list(tags)}))["prompt"]


# --------------------------------------------------------------------------- #
# The playground and everyday flows (the former dev-server smoke cases)
# --------------------------------------------------------------------------- #


@scenario()
async def playground(ctx):
    page_status, _type, page = await ctx.get("/")
    js_status, js_type, _js = await ctx.get(
        "/extensions/comfyui-prompt-library/prompt_librarian/index.js"
    )
    with ctx.step("ping"):
        ping = await ctx.api("/ping")
    with ctx.step("browse"):
        hits = (await ctx.api("/search"))["hits"]
    return {
        "page": page_status,
        "config_injected": "window.__DEV__" in page,
        "entry_js": [js_status, "javascript" in js_type],
        "count": ping["count"],
        "corrupt": ping["corrupt"],
        "hits": len(hits),
    }


@scenario()
async def save_and_find(ctx):
    with ctx.step("create"):
        pid = (await _create(ctx))["id"]
    with ctx.step("search"):
        found = await ctx.api("/search", q="smokecheck")
    meta = await ctx.api("/meta", body={"ids": [pid]})
    with ctx.step("autocomplete"):
        completion = await ctx.api("/autocomplete", word_prefix="smoke", phrase_prefix="smoke")
    return {
        "first_hit_is_new": found["hits"][0]["id"] == pid,
        "labelled": bool(found["hits"][0]["label"]),
        "meta": pid in meta["meta"],
        "suggestion": completion["suggestions"][0],
    }


@scenario()
async def edit_and_history(ctx):
    pid = (await _create(ctx))["id"]
    with ctx.step("update"):
        await ctx.api("/update", body={"id": pid, "body": _BODY + " at dusk"})
    body = (await ctx.api("/prompt", id=pid))["prompt"]["body"]
    versions = (await ctx.api("/versions", id=pid))["versions"]
    return {"body_updated": body.endswith("at dusk"), "versions": len(versions)}


@scenario()
async def delete(ctx):
    pid = (await _create(ctx))["id"]
    with ctx.step("delete"):
        deleted = (await ctx.api("/delete", body={"id": pid}))["deleted"]
    return {"deleted": deleted, "found_after": (await ctx.api("/search", q="smokecheck"))["total"]}


@scenario()
async def bulk_tags(ctx):
    pid = (await _create(ctx))["id"]
    with ctx.step("retag"):
        count = (await ctx.api("/bulk/retag", body={"ids": [pid], "add": ["reviewed"]}))["count"]
    tags = {tag["tag"] for tag in (await ctx.api("/taxonomy"))["tags"]}
    return {"retagged": count, "tag_listed": "reviewed" in tags}


@scenario()
async def duplicates_and_compare(ctx):
    await _create(ctx)
    with ctx.step("find_similar"):
        matches = (await ctx.api("/dupes", body={"text": _BODY}))["matches"]
    with ctx.step("all_pairs"):
        pairs = await ctx.api("/dupes/all")
    diff = await ctx.api("/compare", body={"a_text": _BODY, "b_text": _BODY + " at dusk"})
    return {"matches": len(matches), "groups": len(pairs["groups"]), "diff": bool(diff["diff"])}


@scenario()
async def resolve(ctx):
    await ctx.api("/snippet", body={"name": "smokecheck", "body": "synthetic style"})
    snippets = (await ctx.api("/snippets"))["snippets"]
    wildcard = (await ctx.api("/wildcards"))["names"][0]
    with ctx.step("resolve"):
        resolved = await ctx.api("/resolve", body={"text": f"[[smokecheck]] __{wildcard}__"})
    return {
        "snippet_listed": "smokecheck" in snippets,
        "snippet_expanded": resolved["text"].startswith("synthetic style "),
        "missing": resolved["missing"],
    }


@scenario()
async def settings(ctx):
    with ctx.step("save"):
        saved = await ctx.api("/settings", body={"dupe_threshold": 0.85})
    return {"dupe_threshold": saved["settings"]["dupe_threshold"]}


@scenario()
async def export_and_restore(ctx):
    pid = (await _create(ctx))["id"]
    with ctx.step("export"):
        exported = (await ctx.api("/export"))["library"]
    await ctx.api("/delete", body={"id": pid})
    gone = (await ctx.api("/search", q="smokecheck"))["total"]
    with ctx.step("import"):
        await ctx.api("/import", body={"library": exported, "replace": True})
    return {
        "exported": any(p["id"] == pid for p in exported["prompts"]),
        "after_delete": gone,
        "after_restore": (await ctx.api("/search", q="smokecheck"))["total"],
    }


# --------------------------------------------------------------------------- #
# Loading into the node and usage
# --------------------------------------------------------------------------- #


@scenario(seed=50)
async def pick_row(ctx):
    """What the modal does when a row is picked: fetch it, then count a use."""
    with ctx.step("browse"):
        hits = (await ctx.api("/search", sort="recent"))["hits"]
    pid = hits[0]["id"]
    with ctx.step("load"):
        rec = (await ctx.api("/prompt", id=pid))["prompt"]
    with ctx.step("count_use"):
        used = await ctx.api("/usage", body={"id": pid, "body": rec["body"]})
    edited = await ctx.api("/usage", body={"id": pid, "body": rec["body"] + " (unsaved edit)"})
    return {
        "page": len(hits),
        "counted": used["counted"],
        "used_delta": used["prompt"]["used"] - rec["used"],
        "unsaved_edit_counted": edited["counted"],
    }


@scenario()
async def node_run(ctx):
    rec = await _create(ctx, body="a {red|blue} lighthouse")
    with ctx.step("run_saved"):
        saved = ctx.run_node(text=rec["body"], prompt_id=rec["id"], seed=7)
    edited = ctx.run_node(text=rec["body"] + " at dusk", prompt_id=rec["id"], seed=7)
    again = ctx.run_node(text=rec["body"], prompt_id=rec["id"], seed=7)
    used = (await ctx.api("/prompt", id=rec["id"]))["prompt"]["used"]
    return {
        "counted": saved["ui"]["counted"],
        "edited_counted": edited["ui"]["counted"],
        "deterministic": saved["result"] == again["result"],
        "resolved": saved["result"][0] in ("a red lighthouse", "a blue lighthouse"),
        "used": used,
    }


# --------------------------------------------------------------------------- #
# Editing safety
# --------------------------------------------------------------------------- #


@scenario()
async def rate_then_save(ctx):
    """A rating stamps `updated`; the editor's next save must use the new stamp."""
    rec = await _create(ctx)
    with ctx.step("rate"):
        rated = (await ctx.api("/rate", body={"id": rec["id"], "rating": 4}))["prompt"]
    with ctx.step("save"):
        status, saved = await ctx.call(
            "/update",
            body={"id": rec["id"], "body": _BODY + " edited", "expect_updated": rated["updated"]},
        )
    stale, _ = await ctx.call(
        "/update",
        body={"id": rec["id"], "body": "stale", "expect_updated": "2000-01-01T00:00:00Z"},
    )
    return {"save_after_rate": status, "rating_kept": saved["prompt"]["rating"], "stale": stale}


@scenario()
async def locked_writer(ctx):
    """Another connection holds the write lock; our write waits, then lands."""
    ready = threading.Event()

    def hold(seconds=0.4):
        con = sqlite3.connect(ctx.library, timeout=10.0)
        try:
            con.execute("BEGIN IMMEDIATE")
            ready.set()
            time.sleep(seconds)
            con.rollback()
        finally:
            con.close()

    holder = threading.Thread(target=hold)
    holder.start()
    ready.wait(5)
    started = time.monotonic()
    with ctx.step("create_under_lock"):
        status, _ = await ctx.call("/create", body={"body": "written under a lock"})
    waited = time.monotonic() - started
    holder.join()
    ping = await ctx.api("/ping")
    return {
        "status": status,
        "waited_for_lock": waited >= 0.3,
        "corrupt": ping["corrupt"],
        "count": ping["count"],
    }


# --------------------------------------------------------------------------- #
# Performance budget
# --------------------------------------------------------------------------- #


@scenario(seed=0)
async def dupes_after_usage(ctx):
    """A run changes no body; the grouped view must not rescan every pair."""
    first = await _create(ctx)
    await _create(ctx, body=_TWIN)
    for i in range(6):
        await _create(ctx, body=f"unrelated subject number {i} in a quiet field")
    with ctx.step("grouped_cold"):
        await ctx.api("/search", group="1")
    with ctx.step("usage"):
        await ctx.api("/usage", body={"id": first["id"], "body": first["body"]})
    with ctx.step("grouped_after_usage"):
        grouped = await ctx.api("/search", group="1")
    pairs = await ctx.api("/dupes/all")
    return {"groups": len(pairs["groups"]), "hits": grouped["total"]}


@scenario(seed=300)
async def scale(ctx):
    with ctx.step("browse"):
        await ctx.api("/search")
    with ctx.step("query"):
        found = await ctx.api("/search", q="portrait light")
    with ctx.step("grouped_cold"):
        grouped = await ctx.api("/search", group="1")
    with ctx.step("grouped_warm"):
        await ctx.api("/search", group="1")
    with ctx.step("taxonomy"):
        await ctx.api("/taxonomy")
    return {"total": found["total"], "grouped_total": grouped["total"]}
