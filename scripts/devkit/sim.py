"""Run every scenario on its own fresh library and compare against the baseline.

Per step the sim records SQLite connections opened, SQL statements executed
and wall time. The committed baseline holds outcomes and the two counts, which
are deterministic; timings are machine-dependent and only warn.

    FAIL  outcome changed, a count went up, or a scenario is unknown
    WARN  a step is more than 2x slower (and more than 25 ms slower) than baseline
    note  a count went down; `dev.py baseline` accepts it
"""

import asyncio
import contextlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

from . import server
from .scenarios import SCENARIOS

BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "baseline.json")
SLOWER = 2.0
SLOWER_FLOOR_MS = 25.0

_connects = [0]
_statements = [0]
_COUNTS = ("connections", "statements")
_pinned = {}  # name -> the function currently bound in the pack's modules

#: Seeds are stamped from here; scenario writes from SCENARIO_EPOCH, so a
#: scenario's records always sort as the newest.
SEED_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)
SCENARIO_EPOCH = datetime(2030, 1, 1, tzinfo=timezone.utc)


def _count_connections():
    """Count every sqlite3.connect, and every statement run on it, from any thread."""
    real = sqlite3.connect

    def statement(_sql):
        _statements[0] += 1

    def counting(*args, **kwargs):
        _connects[0] += 1
        con = real(*args, **kwargs)
        con.set_trace_callback(statement)
        return con

    sqlite3.connect = counting


def _pin(epoch, first_id):
    """Make ids and timestamps a function of call order, not of the clock.

    With random ids and one-second stamps, ties in `updated` break by chance,
    so page order, and with it the connection counts, would depend on how fast
    the disk is. Each call advances the clock one second and the id by one.
    The library binds both by name in several modules, so rebind by identity.
    """
    from prompt_librarian.shared import clock

    tick = [0]

    def now_iso():
        tick[0] += 1
        stamp = epoch + timedelta(seconds=tick[0])
        return stamp.isoformat(timespec="seconds").replace("+00:00", "Z")

    def new_id():
        tick[0] += 1
        return f"{first_id + tick[0]:032x}"

    for name, fake in (("now_iso", now_iso), ("new_id", new_id)):
        current = _pinned.get(name, getattr(clock, name))
        hits = 0
        for module_name, module in list(sys.modules.items()):
            if not module_name.startswith("prompt_librarian") or module is None:
                continue
            for attr, value in list(vars(module).items()):
                if value is current:
                    setattr(module, attr, fake)
                    hits += 1
        if not hits:
            server.die(f"cannot pin {name}: no module binds it any more")
        _pinned[name] = fake


class Context:
    """What a scenario may touch: the HTTP API, the node, the library path."""

    def __init__(self, client, library):
        self.client = client
        self.library = library
        self.steps = {}

    async def call(self, path, body=None, **params):
        method = "GET" if body is None else "POST"
        url = server.API_PREFIX + "/prompt_librarian" + path
        async with self.client.request(method, url, params=params, json=body) as response:
            return response.status, await response.json()

    async def api(self, path, body=None, **params):
        status, payload = await self.call(path, body, **params)
        if status != 200:
            raise AssertionError(f"{path}: {status} {payload}")
        return payload

    async def get(self, url):
        async with self.client.get(url) as response:
            return response.status, response.content_type, await response.text()

    def run_node(self, **inputs):
        from prompt_librarian.node import PromptLibrarian

        return PromptLibrarian().run(**inputs)

    @contextlib.contextmanager
    def step(self, label):
        before = (_connects[0], _statements[0])
        started = time.perf_counter()
        try:
            yield
        finally:
            self.steps[label] = {
                "connections": _connects[0] - before[0],
                "statements": _statements[0] - before[1],
                "ms": round((time.perf_counter() - started) * 1000, 1),
            }


def _seeded(root, seed_count, templates):
    """Seed each library size once; seeding is thousands of commits."""
    if seed_count not in templates:
        _pin(SEED_EPOCH, 0)
        template = server.fresh_dir(os.path.join(root, f"_seed_{seed_count}"), root)
        library = os.path.join(template, "library.sqlite3")
        server.seed(server.open_library(library, root), seed_count)
        templates[seed_count] = template
    return templates[seed_count]


async def _run_one(name, seed_count, fn, root, templates):
    from aiohttp.test_utils import TestClient, TestServer

    scratch = server.guard_scratch(os.path.join(root, name), root)
    shutil.copytree(_seeded(root, seed_count, templates), scratch)
    library = os.path.join(scratch, "library.sqlite3")
    dev_app = server.open_library(library, root)
    _pin(SCENARIO_EPOCH, 1 << 64)
    site = server.build_app(dev_app)
    async with TestClient(TestServer(site)) as client:
        ctx = Context(client, library)
        with ctx.step("total"):
            outcome = await fn(ctx)
    return {"outcome": outcome, "steps": ctx.steps}


def run_all():
    """Every scenario, in registration order, each on a fresh library.

    Libraries are throwaway, so they live in the OS temp directory: local and
    fast, even when the repo sits on a slow or network drive.
    """
    root = os.path.realpath(tempfile.mkdtemp(prefix="prompt-librarian-sim-"))
    server.prepare(root)
    _count_connections()
    results, templates = {}, {}
    try:
        for name, (seed_count, fn) in SCENARIOS.items():
            results[name] = asyncio.run(_run_one(name, seed_count, fn, root, templates))
    finally:
        shutil.rmtree(root, ignore_errors=True)
    return results


def _compare_steps(name, now, then, lines):
    failed = False
    for label, step in now.items():
        old = then.get(label)
        if old is None:
            lines.append(f"  note  {name}.{label}: new step")
            continue
        for count in _COUNTS:
            was, now = old.get(count), step[count]
            if was is None or now == was:
                continue
            verdict = "FAIL" if now > was else "note"
            lines.append(f"  {verdict}  {name}.{label}: {was} -> {now} {count}")
            failed = failed or now > was
        slower = step["ms"] > old["ms"] * SLOWER and step["ms"] - old["ms"] > SLOWER_FLOOR_MS
        if slower:
            lines.append(f"  WARN  {name}.{label}: {old['ms']} -> {step['ms']} ms")
    return failed


def compare(results, baseline):
    """Return (ok, report lines)."""
    lines, ok = [], True
    for name, result in results.items():
        then = baseline.get(name)
        if then is None:
            lines.append(f"  FAIL  {name}: not in the baseline (run `dev.py baseline`)")
            ok = False
            continue
        if result["outcome"] != then["outcome"]:
            lines.append(f"  FAIL  {name}: outcome changed")
            lines.append(f"          was {json.dumps(then['outcome'], sort_keys=True)}")
            lines.append(f"          now {json.dumps(result['outcome'], sort_keys=True)}")
            ok = False
        if _compare_steps(name, result["steps"], then["steps"], lines):
            ok = False
    for name in baseline:
        if name not in results:
            lines.append(f"  note  {name}: in the baseline but no longer a scenario")
    return ok, lines


def table(results):
    rows = []
    for name, result in results.items():
        for label, step in result["steps"].items():
            key = f"{name}.{label}"
            rows.append(
                f"  {key:42s} {step['connections']:6d} conn {step['statements']:7d} sql"
                f" {step['ms']:9.1f} ms"
            )
    return rows


def load_baseline():
    try:
        with open(BASELINE, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def write_baseline(results):
    with open(BASELINE, "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2, sort_keys=True)
        fh.write("\n")
