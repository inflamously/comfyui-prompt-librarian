"""Serve the Prompt Librarian without ComfyUI: the real routes on a scratch library.

Mounts the REAL ``/prompt_librarian/*`` routes against a scratch SQLite library,
serves the REAL ``web/`` tree at ComfyUI's URL layout, and supplies stub
``/scripts/{app,api}.js`` from ``devharness/``. ComfyUI's own ``/prompt`` and
``/view`` are stood in for by placeholder renders (``pictures.py``), so word
pictures can be generated and previewed. Needs only aiohttp, which ComfyUI
already provides; the pictures also need Pillow, which it provides too.

DATA SAFETY
-----------
This server must be unable to touch a real library, so four independent layers
have to fail before it could:

  1. The app is built with ``path=...``, which fixes its database and wildcard
     paths.
  2. A stub ``folder_paths`` is injected before the pack is imported, so any
     module-level path helper resolves into the scratch root too. That
     includes ComfyUI's output, input and temp folders.
  3. ``shared.paths._FALLBACK_USER_DIR`` is pinned, covering the branch where
     ``folder_paths`` is absent or raises.
  4. ``guard_scratch()`` refuses anything outside ``.devserver/`` or shaped
     like a real library, and any existing file this tool did not create.

The scratch app is installed with ``app.use()``; routes and the node reach the
library only through ``app.current()``, so nothing else needs repointing.
"""

import asyncio
import json
import mimetypes
import os
import posixpath
import shutil
import sys
import threading
import time
import types

from . import pictures
from .data import SNIPPETS, WILDCARDS, prompt_seeds

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = os.path.join(ROOT, "web")
DEVHARNESS = os.path.join(ROOT, "devharness")
SCRATCH_ROOT = os.path.join(ROOT, ".devserver")

#: ComfyUI serves a pack at /extensions/<dir-name>/; the depth is what the
#: hardcoded ../ walks in the four host-importing files rely on.
MOUNT = "/extensions/comfyui-prompt-library"
#: ComfyUI's API prefix. Routes are mounted under it ONLY, never also at root:
#: a bare fetch("/prompt_librarian/…") 404s behind a proxy, and answering both
#: would hide exactly that bug.
API_PREFIX = "/api"

#: Every file that walks out of web/ to reach ComfyUI's core tree.
HOST_IMPORTS = (
    ("prompt_librarian/index.js", "../../../scripts/app.js"),
    ("prompt_librarian/api/request.js", "../../../../scripts/api.js"),
    ("prompt_store/index.js", "../../../scripts/app.js"),
    ("prompt_store/api.js", "../../../scripts/api.js"),
)

BOOT_ID = str(int(time.time() * 1000))
_MARKER = ".devserver"


def die(msg):
    print(f"[dev] {msg}", file=sys.stderr)
    raise SystemExit(2)


def require_aiohttp():
    """Fail up front, with the fix, rather than deep inside build_app()."""
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        die(
            "aiohttp is not installed in this interpreter:\n"
            f"    {sys.executable}\n\n"
            "  ComfyUI provides aiohttp, so either install it here:\n"
            '      pip install aiohttp          (or: pip install -e ".[dev]")\n\n'
            "  or run this script with the Python you start ComfyUI with, e.g.\n"
            "      ..\\..\\python_embeded\\python.exe scripts\\dev.py\n"
            "      <your-venv>/bin/python scripts/dev.py"
        )


# --------------------------------------------------------------------------- #
# Safety
# --------------------------------------------------------------------------- #


def guard_scratch(path, root=SCRATCH_ROOT):
    """Refuse anything that could be a real library, or outside ``root``."""
    real = os.path.realpath(path)
    parts = [p.casefold() for p in real.split(os.sep) if p]
    # The real thing lives at <user>/default/prompt-librarian/library.sqlite3.
    if "prompt-librarian" in parts and "default" in parts and "user" in parts:
        die(f"{real}\n  looks like a real ComfyUI library. Refusing to start.")
    scratch = os.path.realpath(root)
    try:
        inside = os.path.commonpath([real, scratch]) == scratch
    except ValueError:  # different drives on Windows
        inside = False
    if not inside:
        die(f"{real}\n  is outside {scratch}. Refusing to start.")
    return real


def fresh_dir(path, root=SCRATCH_ROOT):
    """Wipe and recreate a scratch directory, but only one this tool created."""
    real = guard_scratch(path, root)
    if os.path.exists(real):
        if not os.path.exists(os.path.join(real, _MARKER)):
            die(f"{real}\n  exists and was not created by the dev tool. Refusing to wipe it.")
        shutil.rmtree(real)
    os.makedirs(real)
    with open(os.path.join(real, _MARKER), "w", encoding="utf-8"):
        pass
    return real


def prepare(scratch_root):
    """Stub ComfyUI, then import the pack. Must run before anything else imports it."""
    if "prompt_librarian" in sys.modules:
        die("the pack was imported before its folder_paths stub was installed")
    stub = types.ModuleType("folder_paths")
    stub.get_user_directory = lambda: scratch_root
    for kind, folder in pictures.comfy_dirs(scratch_root).items():
        setattr(stub, f"get_{kind}_directory", lambda folder=folder: folder)
    stub.__pl_dev_stub__ = True
    sys.modules["folder_paths"] = stub
    if ROOT not in sys.path:
        sys.path.insert(0, ROOT)

    from prompt_librarian.shared import paths

    paths._FALLBACK_USER_DIR = scratch_root
    import prompt_librarian.api  # noqa: F401 - fills the route table


def open_library(library, root=SCRATCH_ROOT):
    """Build a scratch app on ``library`` and make it the one routes and the node use."""
    from prompt_librarian import app
    from prompt_librarian.features import dupes, search

    guard_scratch(library, root)
    # `migrate_from=False`: a scratch library never adopts a neighbouring legacy file.
    scratch = app.build(path=library, migrate_from=False)
    previous = app.use(scratch)
    if previous is not None:
        previous.lib.close()
    # Both caches are keyed on revision numbers, which every fresh library reuses.
    search.invalidate_index()
    dupes.invalidate()
    return scratch


# --------------------------------------------------------------------------- #
# Seeding
# --------------------------------------------------------------------------- #


def seed(dev_app, n):
    """Fill the scratch library through the feature use-cases, never by writing JSON.

    The curated first fifty records cover the shapes the UI needs; generated
    additions beyond that keep larger counts useful for scale work.
    """
    from prompt_librarian.features.library.ignored import ignore_pair
    from prompt_librarian.features.library.snippets import set_snippet
    from prompt_librarian.features.prompts.create import create_prompt
    from prompt_librarian.features.prompts.update import update_prompt
    from prompt_librarian.features.prompts.usage import record_usage

    lib = dev_app.lib
    specs = prompt_seeds(n)
    made = {}
    for spec in specs:
        first_body = spec.history[0] if spec.history else spec.body
        rec = create_prompt(
            lib,
            body=first_body,
            tags=spec.tags,
            rating=spec.rating,
            notes=spec.notes,
            pinned=spec.pinned,
        )
        made[spec.key] = rec

        for draft in spec.history[1:]:
            update_prompt(lib, rec["id"], body=draft)
        if spec.deep_history:
            for k in range(52):
                update_prompt(
                    lib,
                    rec["id"],
                    body=f"Color-script exploration {k + 1:02d}: rescue boat, storm, horizon light",
                )
        if spec.history:
            update_prompt(lib, rec["id"], body=spec.body)

        for _ in range(spec.used):
            record_usage(lib, rec["id"])

    for spec in specs:
        if spec.ignore_with and spec.key in made and spec.ignore_with in made:
            ignore_pair(lib, made[spec.key]["id"], made[spec.ignore_with]["id"])

    for name, body in SNIPPETS.items():
        set_snippet(lib, name, body)

    wc = os.path.join(os.path.dirname(lib.path), "wildcards")
    os.makedirs(wc, exist_ok=True)
    for name, choices in WILDCARDS.items():
        with open(os.path.join(wc, name + ".txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(choices) + "\n")
    # One deliberately large source keeps wildcard-search performance testable.
    with open(os.path.join(wc, "big.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(f"variant {i}" for i in range(5000)))


def seeded_copy(target, count):
    """Put a freshly seeded library in ``target``, copied from a cached seed.

    Seeding is thousands of commits; the cache in ``.devserver/seed/`` is rebuilt
    only when the pack's Python or the seed data changes.
    """
    template = os.path.join(SCRATCH_ROOT, "seed")
    here = os.path.dirname(os.path.abspath(__file__))
    seeders = ":".join(str(os.stat(os.path.join(here, name)).st_mtime_ns)
                       for name in ("data.py", "pictures.py"))
    fingerprint = f"{count}:{newest_mtime(os.path.join(ROOT, 'prompt_librarian'))}:{seeders}"
    stamp = os.path.join(template, ".fingerprint")
    try:
        with open(stamp, encoding="utf-8") as fh:
            fresh = fh.read() == fingerprint
    except OSError:
        fresh = False
    if not fresh:
        fresh_dir(template)
        seeded = open_library(os.path.join(template, "library.sqlite3"))
        seed(seeded, count)
        try:
            pictures.seed_pictures(seeded)
        except ImportError:
            print("[dev] Pillow is not installed: the library starts without word pictures")
        with open(stamp, "w", encoding="utf-8") as fh:
            fh.write(fingerprint)
    fresh_dir(target)
    shutil.copytree(template, target, dirs_exist_ok=True)
    os.remove(os.path.join(target, ".fingerprint"))
    return open_library(os.path.join(target, "library.sqlite3"))


# --------------------------------------------------------------------------- #
# The app
# --------------------------------------------------------------------------- #


def _assert_mount_depth():
    """Each hardcoded ../ walk must land on /scripts/{app,api}.js."""
    for src, up in HOST_IMPORTS:
        got = posixpath.normpath(posixpath.join(MOUNT + "/", posixpath.dirname(src), up))
        want = "/scripts/" + posixpath.basename(up)
        if got != want:
            die(f"mount {MOUNT!r} breaks {src}: {up} resolves to {got}, need {want}")


def manifest():
    """Every .js under web/, mount-relative, in a stable order."""
    out = []
    for base, _dirs, files in os.walk(WEB):
        for name in sorted(files):
            if name.endswith(".js"):
                rel = os.path.relpath(os.path.join(base, name), WEB)
                out.append(rel.replace(os.sep, "/"))
    return sorted(out)


def build_app(dev_app, reset=None, reload=False):
    """The playground app. ``reset()`` rebuilds the library for ``/__dev/reset``."""
    from aiohttp import web

    from prompt_librarian import api
    from prompt_librarian.features.prompts.get import count_prompts

    # Windows' registry maps .js to text/plain, which a browser refuses to
    # execute as a module.
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/css", ".css")
    _assert_mount_depth()

    routes = web.RouteTableDef()
    api.register(routes)
    state = {"app": dev_app}

    @web.middleware
    async def no_store(request, handler):
        response = await handler(request)
        # Always refetch, so you never chase a phantom "my edit didn't apply".
        response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response

    app = web.Application(middlewares=[no_store])
    dev = web.RouteTableDef()

    @dev.get("/")
    async def index(request):
        with open(os.path.join(DEVHARNESS, "index.html"), encoding="utf-8") as fh:
            html = fh.read()
        config = json.dumps(
            {
                "mount": MOUNT,
                "apiPrefix": API_PREFIX,
                "library": state["app"].lib.path,
                "reload": bool(reload),
                "boot": BOOT_ID,
            }
        )
        html = html.replace(
            "<!-- __DEV_CONFIG__ : templated by scripts/devkit/server.py -->",
            f"<script>window.__DEV__ = {config};</script>",
        )
        return web.Response(text=html, content_type="text/html")

    @dev.get("/__dev/manifest")
    async def manifest_route(request):
        return web.json_response(manifest())

    @dev.get("/__dev/rev")
    async def rev(request):
        return web.json_response(
            {
                "boot": BOOT_ID,
                "web": newest_mtime(WEB, DEVHARNESS),
                "py": newest_mtime(os.path.join(ROOT, "prompt_librarian")),
            }
        )

    @dev.get("/__dev/status")
    async def status(request):
        lib = state["app"].lib
        return web.json_response(
            {
                "library": lib.path,
                "rev": lib.revision(),
                "count": count_prompts(lib),
                "routes": len(list(routes)),
            }
        )

    @dev.post("/__dev/sample_image")
    async def sample_image_route(request):
        label = request.query.get("label") or "sample"
        try:
            ref = await _offload(pictures.sample_image, _comfy_dirs(), label)
        except ImportError:
            return web.json_response({"error": "Pillow is not installed"}, status=500)
        return web.json_response(ref)

    @dev.post("/__dev/reset")
    async def reset_route(request):
        if reset is not None:
            # Connections stay open per thread; Windows cannot delete an open file.
            state["app"].lib.close()
            state["app"] = reset()
        return web.json_response({"ok": True, "count": count_prompts(state["app"].lib)})

    app.add_routes(dev)
    app.router.add_static("/scripts/", os.path.join(DEVHARNESS, "scripts"))
    app.router.add_static("/__dev/harness/", os.path.join(DEVHARNESS, "harness"))
    app.router.add_static(MOUNT + "/", WEB)

    backend = web.Application()
    backend.add_routes(routes)
    backend.add_routes(comfy_routes())
    app.add_subapp(API_PREFIX, backend)
    return app


def _comfy_dirs():
    from prompt_librarian.features.word_images.sources import comfy_roots

    return comfy_roots()  # the folder_paths stub's, from prepare()


async def _offload(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(None, fn, *args)


def comfy_routes():
    """ComfyUI's own ``/prompt`` and ``/view``, for the word-picture generator.

    ``/prompt`` renders at once and returns the outputs beside the prompt id
    under ``__dev``; the harness's fake ``api`` replays them as the websocket
    events a real ComfyUI would send (devharness/harness/fake-api.js).
    """
    from aiohttp import web

    from prompt_librarian.features.word_images import resolve_source

    host = web.RouteTableDef()
    queued = iter(range(1, 1 << 62))

    @host.post("/prompt")
    async def queue_prompt(request):
        try:
            body = await request.json()
            outputs = await _offload(pictures.run_prompt, body.get("prompt"), _comfy_dirs())
        except ImportError:
            return web.json_response({"error": {"message": "Pillow is not installed"}}, status=500)
        except (ValueError, AttributeError) as exc:
            return web.json_response(
                {"error": {"type": "invalid_prompt", "message": str(exc)}, "node_errors": {}},
                status=400,
            )
        number = next(queued)
        return web.json_response(
            {"prompt_id": f"dev-{BOOT_ID}-{number}", "number": number, "node_errors": {},
             "__dev": {"outputs": outputs}}
        )

    @host.get("/view")
    async def view(request):
        q = request.query
        try:
            path = resolve_source(
                q.get("filename", ""), q.get("subfolder", ""), q.get("type", "output"))
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        if not os.path.isfile(path):
            raise web.HTTPNotFound()
        return web.FileResponse(path)

    return host


# --------------------------------------------------------------------------- #
# Reload
# --------------------------------------------------------------------------- #


def newest_mtime(*dirs):
    newest = 0
    for root in dirs:
        for base, subdirs, files in os.walk(root):
            subdirs[:] = [d for d in subdirs if d not in ("__pycache__", ".git", "node_modules")]
            for name in files:
                if name.endswith(".pyc"):
                    continue
                try:
                    m = os.stat(os.path.join(base, name)).st_mtime_ns
                except OSError:
                    continue
                newest = max(newest, m)
    return newest


def watch_and_reexec(env_keep, interval=0.3):
    """Re-exec on a Python change, keeping the library that is being played with.

    NOT importlib.reload: utils._ROUTES is a module-level list filled purely by
    @_route import side effects, so a reload appends a second copy of every
    route and fragments every singleton. Re-exec is fast here because there is
    no ComfyUI, no torch and no model scan.
    """
    watched = (os.path.join(ROOT, "prompt_librarian"), os.path.join(ROOT, "scripts"))
    baseline = newest_mtime(*watched)

    def loop():
        while True:
            time.sleep(interval)
            if newest_mtime(*watched) != baseline:
                print("[dev] python changed — restarting")
                os.environ[env_keep] = "1"
                os.execv(sys.executable, [sys.executable, *sys.argv])

    threading.Thread(target=loop, daemon=True).start()
