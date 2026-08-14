#!/usr/bin/env python3
"""Emit the ``/prompt_librarian/*`` OpenAPI document, or list the routes.

    python scripts/openapi.py                  # the route table, one line each
    python scripts/openapi.py --format json    # the spec, to stdout
    python scripts/openapi.py -o openapi.json  # the spec, to a file

The listing needs nothing but the standard library — importing the route table
touches neither ComfyUI nor aiohttp. The spec needs pydantic, which generates
every schema from the dataclasses in ``prompt_librarian/api/schemas.py``:

    pip install -e ".[dev]"
"""

import argparse
import json
import os
import re
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from prompt_librarian.api.utils import _ROUTES  # noqa: E402  (follows sys.path)

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
    width = max(len(route.path) for route in _ROUTES)
    out = []
    for route in _ROUTES:
        out.append(f"{route.method.upper():<4} {route.path:<{width}}  {route.spec.op}")
        if route.spec.summary:
            out.append(f"{'':<4} {'':<{width}}  {route.spec.summary}")
        takes = route.spec.query or route.spec.body
        out.append(f"{'':<4} {'':<{width}}  {takes.__name__ + ' ' if takes else ''}"
                   f"-> {route.spec.returns.__name__}")
    out.append("")
    out.append(f"{len(_ROUTES)} routes")
    return "\n".join(out)


def spec(indent):
    """The OpenAPI document as text, or an exit with an actionable message."""
    try:
        from prompt_librarian.api import openapi
    except ImportError as exc:
        raise SystemExit(f"{exc}\n\nThe spec is generated with pydantic: "
                         'install the dev extras with `pip install -e ".[dev]"`, '
                         "or use the default --format table, which needs nothing.") from exc
    return json.dumps(openapi.document(version=pack_version()),
                      indent=indent or None, sort_keys=False) + "\n"


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

    text = spec(args.indent)
    if not args.out:
        sys.stdout.write(text)
        return 0
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(f"wrote {args.out} ({len(_ROUTES)} routes)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
