#!/usr/bin/env python3
"""Serve the Prompt Librarian without ComfyUI, so the frontend can be iterated on.

    python scripts/devserver.py                    # 50 curated prompts, http://localhost:8189
    python scripts/devserver.py --seed 2000        # add generated prompts for scale testing
    python scripts/devserver.py --reload           # re-exec on a .py change
    python scripts/devserver.py --check            # assert and exit; CI-able

Mounts the REAL 34 ``/prompt_librarian/*`` routes against a scratch SQLite
store, serves the REAL ``web/`` tree at ComfyUI's URL layout, and
supplies stub ``/scripts/{app,api}.js`` from ``devharness/``. Edit a file under
``web/`` and refresh; ComfyUI is never involved.

Needs only aiohttp, which ComfyUI already provides.

DATA SAFETY
-----------
This server must be unable to touch a real library, so four independent layers
have to fail before it could:

  1. The store takes ``path=...``, which overrides its database and wildcard
     paths.
  2. A stub ``folder_paths`` is injected before the pack is imported, so any
     module-level path helper resolves into the scratch root too.
  3. ``store.utils._FALLBACK_USER_DIR`` is pinned, covering the branch where
     ``folder_paths`` is absent or raises.
  4. ``_guard_scratch()`` refuses to start on anything that looks like a real
     library, and refuses to write to a pre-existing file this server did not
     create.

The store is then repointed BY OBJECT IDENTITY across every module attribute --
not by name. ``prompt_librarian/wildcards.py`` binds it as ``_STORE``, which a
name-based sweep (like the one in tests/test_api.py) misses, and the wildcard
routes would otherwise read the real user directory.
"""

import argparse
import json
import mimetypes
import os
import posixpath
import shutil
import sys
import threading
import time
import types

if __package__:
    from .devdata import DEFAULT_PROMPT_COUNT, SNIPPETS, WILDCARDS, prompt_seeds
else:
    from devdata import DEFAULT_PROMPT_COUNT, SNIPPETS, WILDCARDS, prompt_seeds

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
_WEB = os.path.join(_ROOT, "web")
_DEVHARNESS = os.path.join(_ROOT, "devharness")
_SCRATCH_ROOT = os.path.join(_ROOT, ".devserver")

#: ComfyUI serves a pack at /extensions/<dir-name>/; the depth is what the
#: hardcoded ../ walks in the four host-importing files rely on.
DEFAULT_MOUNT = "/extensions/comfyui-prompt-library"

#: Every file that walks out of web/ to reach ComfyUI's core tree.
HOST_IMPORTS = (
    ("prompt_librarian/index.js", "../../../scripts/app.js"),
    ("prompt_librarian/api/request.js", "../../../../scripts/api.js"),
    ("prompt_store/index.js", "../../../scripts/app.js"),
    ("prompt_store/api.js", "../../../scripts/api.js"),
)

BOOT_ID = str(int(time.time() * 1000))


def _die(msg):
    print(f"[devserver] {msg}", file=sys.stderr)
    raise SystemExit(2)


def _require_aiohttp():
    """Fail up front, with the fix, rather than deep inside build_app().

    ComfyUI is built on aiohttp, so its own interpreter always has it and the
    pack deliberately declares no runtime dependencies. Running this script with
    a *different* Python -- a bare system 3.10, say -- is the common way to end
    up without it.
    """
    try:
        import aiohttp  # noqa: F401
    except ImportError:
        _die(
            "aiohttp is not installed in this interpreter:\n"
            f"    {sys.executable}\n\n"
            "  ComfyUI provides aiohttp, so either install it here:\n"
            '      pip install aiohttp          (or: pip install -e ".[dev]")\n\n'
            "  or run this script with the Python you start ComfyUI with, e.g.\n"
            "      ..\\..\\python_embeded\\python.exe scripts\\devserver.py\n"
            "      <your-venv>/bin/python scripts/devserver.py"
        )


# --------------------------------------------------------------------------- #
# Safety
# --------------------------------------------------------------------------- #


def _guard_scratch(path, allow_outside=False):
    """Refuse anything that could be a real library. Returns the realpath."""
    real = os.path.realpath(path)
    parts = [p.casefold() for p in real.split(os.sep) if p]

    # The real thing lives at <user>/default/prompt-librarian/library.sqlite3.
    if "prompt-librarian" in parts and "default" in parts and "user" in parts:
        _die(f"{real}\n  looks like a real ComfyUI library. Refusing to start.")

    scratch = os.path.realpath(_SCRATCH_ROOT)
    if not allow_outside:
        try:
            inside = os.path.commonpath([real, scratch]) == scratch
        except ValueError:  # different drives on Windows
            inside = False
        if not inside:
            _die(f"{real}\n  is outside {scratch}.\n  Pass --allow-outside if you really mean it.")

    # A file this server did not create is not ours to overwrite.
    if os.path.exists(real) and not os.path.exists(real + ".devserver"):
        _die(
            f"{real}\n  already exists and was not created by devserver.\n"
            "  Refusing to write to it. Delete it, or point --library elsewhere."
        )
    return real


def _mark_ours(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".devserver", "a", encoding="utf-8"):
        pass


def _install_folder_paths_stub(scratch_root):
    """Inject the stub BEFORE the pack is imported, as tests/conftest.py does."""
    stub = types.ModuleType("folder_paths")
    stub.get_user_directory = lambda: scratch_root
    stub.__pl_dev_stub__ = True
    sys.modules["folder_paths"] = stub
    return stub


def _repoint_store(dev_store):
    """Replace every binding of the process-wide STORE, by identity.

    Name-based discovery misses ``wildcards._STORE``. A partial swap is the one
    failure mode that reaches real data, so an incomplete result is fatal.
    """
    from prompt_librarian import dedupe, search, wildcards
    from prompt_librarian import store as store_mod

    old = store_mod.STORE
    hits = []
    for name, module in list(sys.modules.items()):
        if not name.startswith("prompt_librarian") or module is None:
            continue
        for attr, value in list(vars(module).items()):
            if value is old:
                setattr(module, attr, dev_store)
                hits.append(f"{name}.{attr}")

    required = {
        "prompt_librarian.store.STORE",
        "prompt_librarian.api.utils.STORE",
        "prompt_librarian.api.registration.STORE",
        "prompt_librarian.api.routes.prompts.STORE",
        "prompt_librarian.wildcards._STORE",
    }
    missing = required - set(hits)
    if missing:
        _die(f"store repoint incomplete, missing: {sorted(missing)}")

    # Bound explicitly rather than relying on the _STORE patch: WildcardFiles
    # accepts a zero-arg callable as `root`, and this survives a rename.
    wildcards.FILES = wildcards.WildcardFiles(root=dev_store.wildcards_dir)

    # Both caches are keyed on id(store), and CPython recycles addresses.
    search.invalidate_index()
    dedupe.invalidate()
    return sorted(hits)


# --------------------------------------------------------------------------- #
# Mount arithmetic
# --------------------------------------------------------------------------- #


def _assert_mount_depth(mount):
    """Each hardcoded ../ walk must land on /scripts/{app,api}.js."""
    for src, up in HOST_IMPORTS:
        got = posixpath.normpath(posixpath.join(mount + "/", posixpath.dirname(src), up))
        want = "/scripts/" + posixpath.basename(up)
        if got != want:
            _die(f"mount {mount!r} breaks {src}: {up} resolves to {got}, need {want}")


def _manifest():
    """Every .js under web/, mount-relative, in a stable order."""
    out = []
    for base, _dirs, files in os.walk(_WEB):
        for name in sorted(files):
            if name.endswith(".js"):
                rel = os.path.relpath(os.path.join(base, name), _WEB)
                out.append(rel.replace(os.sep, "/"))
    return sorted(out)


# --------------------------------------------------------------------------- #
# Seeding
# --------------------------------------------------------------------------- #


def seed(store, n):
    """Fill the scratch library through the PUBLIC api, never by writing JSON.

    Going through create/update/set_rating/... means the envelope is always
    exactly what the real code produces, including version history and stamps.
    The curated first fifty records cover the shapes needed by the UI; generated
    additions keep ``--seed 2000`` useful for pagination and performance work.
    """
    from prompt_librarian.store import DEFAULT_DUPE_THRESHOLD

    specs = prompt_seeds(n)
    made = {}
    for spec in specs:
        first_body = spec.history[0] if spec.history else spec.body
        rec = store.create(
            body=first_body,
            tags=spec.tags,
            rating=spec.rating,
            notes=spec.notes,
            pinned=spec.pinned,
        )
        made[spec.key] = rec

        for draft in spec.history[1:]:
            store.update(rec["id"], body=draft)
        if spec.deep_history:
            for k in range(52):
                store.update(
                    rec["id"],
                    body=f"Color-script exploration {k + 1:02d}: rescue boat, storm, horizon light",
                )
        if spec.history:
            store.update(rec["id"], body=spec.body)

        for _ in range(spec.used):
            store.record_usage(rec["id"])

    for spec in specs:
        if spec.ignore_with and spec.key in made and spec.ignore_with in made:
            store.ignore_pair(made[spec.key]["id"], made[spec.ignore_with]["id"])

    for name, body in SNIPPETS.items():
        store.set_snippet(name, body)

    wc = store.wildcards_dir()
    os.makedirs(wc, exist_ok=True)
    for name, choices in WILDCARDS.items():
        with open(os.path.join(wc, name + ".txt"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(choices) + "\n")
    # One deliberately large source keeps wildcard-search performance testable.
    with open(os.path.join(wc, "big.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(f"variant {i}" for i in range(5000)))

    print(
        f"[devserver] seeded {store.count()} prompts "
        f"(threshold {DEFAULT_DUPE_THRESHOLD}), "
        f"{len(WILDCARDS) + 1} wildcard files, {len(SNIPPETS)} snippets"
    )


# --------------------------------------------------------------------------- #
# The app
# --------------------------------------------------------------------------- #


def build_app(cfg, dev_store, hits):
    from aiohttp import web

    from prompt_librarian import api

    # Windows' registry maps .js to text/plain, which a browser refuses to
    # execute as a module.
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/css", ".css")

    _assert_mount_depth(cfg.mount)

    routes = web.RouteTableDef()
    api.register(routes)

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
        with open(os.path.join(_DEVHARNESS, "index.html"), encoding="utf-8") as fh:
            html = fh.read()
        config = json.dumps(
            {
                "mount": cfg.mount,
                "apiPrefix": cfg.api_prefix,
                "library": dev_store.store_path(),
                "reload": bool(cfg.reload),
                "boot": BOOT_ID,
            }
        )
        html = html.replace(
            "<!-- __DEV_CONFIG__ : templated by scripts/devserver.py -->",
            f"<script>window.__DEV__ = {config};</script>",
        )
        return web.Response(text=html, content_type="text/html")

    @dev.get("/__dev/manifest")
    async def manifest(request):
        return web.json_response(_manifest())

    @dev.get("/__dev/rev")
    async def rev(request):
        return web.json_response(
            {
                "boot": BOOT_ID,
                "web": _newest_mtime(_WEB, _DEVHARNESS),
                "py": _newest_mtime(os.path.join(_ROOT, "prompt_librarian")),
            }
        )

    @dev.get("/__dev/status")
    async def status(request):
        return web.json_response(
            {
                "library": dev_store.store_path(),
                "rev": dev_store.rev(),
                "count": dev_store.count(),
                "routes": len(list(routes)),
                "apiPrefix": cfg.api_prefix,
                "mount": cfg.mount,
                "storeBindings": hits,
            }
        )

    @dev.post("/__dev/reset")
    async def reset(request):
        path = dev_store.store_path()
        parent = os.path.dirname(path)
        shutil.rmtree(parent, ignore_errors=True)
        _mark_ours(path)
        dev_store.reload() if hasattr(dev_store, "reload") else None
        seed(dev_store, cfg.seed)
        return web.json_response({"ok": True, "count": dev_store.count()})

    app.add_routes(dev)
    app.router.add_static("/scripts/", os.path.join(_DEVHARNESS, "scripts"))
    app.router.add_static("/__dev/harness/", os.path.join(_DEVHARNESS, "harness"))
    app.router.add_static(cfg.mount + "/", _WEB)

    if cfg.api_prefix:
        # Mounted under the prefix ONLY, never also at root. request.js exists
        # because a bare fetch("/prompt_librarian/…") works on a default install
        # and 404s behind a proxy; answering both would hide that class of bug.
        backend = web.Application()
        backend.add_routes(routes)
        app.add_subapp(cfg.api_prefix, backend)
    else:
        app.add_routes(routes)

    return app


def _newest_mtime(*dirs):
    newest = 0
    for root in dirs:
        for base, subdirs, files in os.walk(root):
            subdirs[:] = [d for d in subdirs if d not in ("__pycache__", ".git", "node_modules")]
            for name in files:
                if name.endswith((".pyc",)):
                    continue
                try:
                    m = os.stat(os.path.join(base, name)).st_mtime_ns
                except OSError:
                    continue
                if m > newest:
                    newest = m
    return newest


def _watch_and_reexec(interval=0.3):
    """Re-exec on a Python change.

    NOT importlib.reload: utils._ROUTES is a module-level list filled purely by
    @_route import side effects, so a reload appends a second copy of all 29
    routes and fragments every singleton. Re-exec is fast here because there is
    no ComfyUI, no torch and no model scan -- which is the whole point.
    """
    watched = (os.path.join(_ROOT, "prompt_librarian"), os.path.join(_ROOT, "scripts"))
    baseline = _newest_mtime(*watched)

    def loop():
        while True:
            time.sleep(interval)
            if _newest_mtime(*watched) != baseline:
                print("[devserver] python changed — restarting")
                os.execv(sys.executable, [sys.executable, *sys.argv])

    threading.Thread(target=loop, daemon=True).start()


# --------------------------------------------------------------------------- #
# Entry
# --------------------------------------------------------------------------- #


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8189)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--library",
        default=None,
        help="scratch SQLite library file (never a real one)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_PROMPT_COUNT,
        metavar="N",
        help=f"generate N prompts into an empty scratch library (default: {DEFAULT_PROMPT_COUNT})",
    )
    parser.add_argument(
        "--mount",
        default=DEFAULT_MOUNT,
        help="URL prefix web/ is served at; must stay 2 segments deep",
    )
    parser.add_argument(
        "--api-prefix",
        default="/api",
        dest="api_prefix",
        help='ComfyUI\'s API prefix; pass "" to simulate an install without one',
    )
    parser.add_argument(
        "--reload", action="store_true", help="re-exec on a .py change and tell the page to refresh"
    )
    parser.add_argument(
        "--allow-outside", action="store_true", help="permit a --library outside .devserver/"
    )
    parser.add_argument(
        "--check", action="store_true", help="assert everything and exit without listening"
    )
    cfg = parser.parse_args(argv)

    # Before the scratch dir is created, the library is seeded or the store is
    # repointed -- none of which is worth doing if we cannot serve.
    _require_aiohttp()

    if cfg.library is None:
        cfg.library = os.path.join(_SCRATCH_ROOT, "default", "library.sqlite3")

    lib = _guard_scratch(cfg.library, cfg.allow_outside)
    _mark_ours(lib)
    scratch_root = os.path.dirname(os.path.dirname(lib))

    _install_folder_paths_stub(scratch_root)

    from prompt_librarian import store as store_mod
    from prompt_librarian.store import utils as store_utils

    store_utils._FALLBACK_USER_DIR = scratch_root

    # Import the api package BEFORE repointing: the swap walks sys.modules, so a
    # route module that has not been imported yet cannot be swapped and would
    # keep writing to the process-wide store. Importing routes/ is what fills
    # utils._ROUTES, so this also has to happen before build_app().
    import prompt_librarian.api  # noqa: F401

    fresh = not os.path.exists(lib)
    # `migrate_from=False`: a scratch library must never adopt a neighbouring
    # legacy library.json, even if a development tool explicitly requests the
    # opt-in migration behavior.
    dev_store = store_mod.LibrarianStore(path=lib, migrate_from=False)
    hits = _repoint_store(dev_store)

    if cfg.seed and fresh:
        seed(dev_store, cfg.seed)

    app = build_app(cfg, dev_store, hits)

    manifest = _manifest()
    print(f"[devserver] library : {lib}  ({type(dev_store).__name__})")
    print(f"[devserver] prompts : {dev_store.count()}")
    print(f"[devserver] modules : {len(manifest)} under {cfg.mount}/")
    print(f"[devserver] store   : repointed {len(hits)} bindings")

    if cfg.check:
        from prompt_librarian.api.utils import _ROUTES

        assert len(_ROUTES) == 34, f"expected 34 routes, found {len(_ROUTES)}"
        assert manifest, "no .js found under web/"
        assert (
            os.path.realpath(lib).startswith(os.path.realpath(_SCRATCH_ROOT)) or cfg.allow_outside
        ), "library escaped the scratch root"
        print("[devserver] --check OK")
        return 0

    if cfg.reload:
        _watch_and_reexec()

    from aiohttp import web

    print(f"[devserver] http://{cfg.host}:{cfg.port}/")
    web.run_app(app, host=cfg.host, port=cfg.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
