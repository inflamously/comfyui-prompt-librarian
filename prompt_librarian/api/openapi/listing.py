"""The route table as aligned text — what routes exist, at a glance."""

from ..utils import _ROUTES


def table():
    """One block per route: method, path and op id, summary, query/body -> response."""
    width = max(len(route.path) for route in _ROUTES)
    pad = f"{'':<4} {'':<{width}}"
    out = []
    for route in _ROUTES:
        spec = route.spec
        out.append(f"{route.method.upper():<4} {route.path:<{width}}  {spec.op}")
        if spec.summary:
            out.append(f"{pad}  {spec.summary}")
        takes = spec.query or spec.body
        out.append(f"{pad}  {takes.__name__ + ' ' if takes else ''}-> {spec.returns.__name__}")
    out.append("")
    out.append(f"{len(_ROUTES)} routes")
    return "\n".join(out)
