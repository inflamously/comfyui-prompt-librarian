#!/usr/bin/env python3
"""Emit the ``/prompt_librarian/*`` OpenAPI document, or list the routes.

    python scripts/openapi.py                  # the route table, one line each
    python scripts/openapi.py --format json    # the spec, to stdout
    python scripts/openapi.py -o openapi.json  # the spec, to a file

Runs headless: importing the route table needs neither ComfyUI nor aiohttp
(``folder_paths`` is optional in the store, and ``aiohttp`` is only imported
when routes are actually registered), so this works from a plain checkout.
"""

import argparse
import json
import os
import re
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from prompt_librarian.api import openapi  # noqa: E402  (follows the sys.path setup)

_VERSION_RE = re.compile(r'^version\s*=\s*"([^"]+)"', re.MULTILINE)


def pack_version():
    """``version`` from pyproject.toml — regex rather than tomllib, which is 3.11+."""
    try:
        with open(os.path.join(_ROOT, "pyproject.toml"), encoding="utf-8") as handle:
            match = _VERSION_RE.search(handle.read())
    except OSError:
        return "0"
    return match.group(1) if match else "0"


def table():
    """The route table as aligned text — what routes exist, at a glance."""
    rows = openapi.rows()
    width = max(len(path) for _, path, _, _ in rows)
    out = []
    for method, path, op, summary in rows:
        out.append(f"{method:<4} {path:<{width}}  {op}")
        if summary:
            out.append(f"{'':<4} {'':<{width}}  {summary}")
    out.append("")
    out.append(f"{len(rows)} routes, {len(openapi.MODELS)} schemas")
    return "\n".join(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("-f", "--format", choices=("table", "json"), default="table",
                        help="table (default) lists the routes; json emits the spec")
    parser.add_argument("-o", "--out", metavar="PATH",
                        help="write to PATH instead of stdout (implies --format json)")
    parser.add_argument("--indent", type=int, default=2,
                        help="json indent; 0 for one line (default: 2)")
    args = parser.parse_args(argv)

    if args.format == "table" and not args.out:
        print(table())
        return 0

    text = json.dumps(openapi.document(version=pack_version()),
                      indent=args.indent or None, sort_keys=False) + "\n"
    if not args.out:
        sys.stdout.write(text)
        return 0
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(f"wrote {args.out} ({len(openapi.rows())} routes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
