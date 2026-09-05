#!/usr/bin/env python3
"""Play with the Prompt Librarian, or replay its flows, without ComfyUI.

    python scripts/dev.py            play: fresh seeded library, fake node, modal open
    python scripts/dev.py sim        replay every scenario and compare to the baseline
    python scripts/dev.py baseline   replay every scenario and accept the result

Play starts from the same 50 curated prompts on every run and reloads when a
.py file changes (keeping what you did). Sim gives each scenario its own fresh
library; see scripts/devkit/sim.py for what fails and what only warns.

The port is 8189; set PL_DEV_PORT to change it. Run with the Python that
starts ComfyUI (it needs aiohttp).
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from scripts.devkit import server  # noqa: E402
from scripts.devkit.data import DEFAULT_PROMPT_COUNT  # noqa: E402

_KEEP = "PL_DEV_KEEP"  # set by the reloader so a re-exec keeps the library


def play():
    run_dir = os.path.join(server.SCRATCH_ROOT, "play")
    library = os.path.join(run_dir, "library.sqlite3")
    keep = os.environ.pop(_KEEP, "") == "1" and os.path.exists(library)
    if not keep:
        server.fresh_dir(run_dir)
    server.prepare(run_dir)

    def reset():
        return server.seeded_copy(run_dir, DEFAULT_PROMPT_COUNT)

    dev_app = server.open_library(library) if keep else reset()
    site = server.build_app(dev_app, reset=reset, reload=True)
    server.watch_and_reexec(_KEEP)

    from aiohttp import web

    from prompt_librarian.features.prompts.get import count_prompts

    port = int(os.environ.get("PL_DEV_PORT", "8189"))
    print(f"[dev] library : {library}{' (kept)' if keep else ''}")
    print(f"[dev] prompts : {count_prompts(dev_app.lib)}")
    print(f"[dev] http://127.0.0.1:{port}/")
    web.run_app(site, host="127.0.0.1", port=port, print=None)
    return 0


def sim(accept=False):
    from scripts.devkit import sim as runner

    results = runner.run_all()
    print("\n".join(runner.table(results)))
    baseline = runner.load_baseline()
    if accept or baseline is None:
        runner.write_baseline(results)
        print(f"[dev] baseline written: {runner.BASELINE}")
        return 0
    ok, lines = runner.compare(results, baseline)
    if lines:
        print("\n".join(lines))
    print(f"[dev] sim {'OK' if ok else 'FAILED'} ({len(results)} scenarios)")
    return 0 if ok else 1


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    mode = args[0] if args else "play"
    if mode not in ("play", "sim", "baseline") or len(args) > 1:
        print(__doc__)
        return 2
    server.require_aiohttp()
    if mode == "play":
        return play()
    return sim(accept=mode == "baseline")


if __name__ == "__main__":
    raise SystemExit(main())
