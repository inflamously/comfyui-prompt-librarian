"""The handlers themselves — one module per feature group.

Importing this package *is* the registration: every ``@_route`` appends to
``utils._ROUTES`` as a side effect of its module being imported, so the single
import statement below is what turns nine files into one route table. Nothing
else imports these modules by name; :mod:`..api` pulls in the package and reads
the table.

The grouping is the one the OpenAPI document already tags operations by, so a
route's module and its tag never disagree:

``bulk``
    ``/bulk/*`` — one mutation over a whole selection.
``dupes``
    Near-duplicate detection in all three shapes (library-wide, one-vs-N,
    pairwise diff) plus the "keep both" decision.
``library``
    Store-wide facts and whole-library moves: ping, export, import, settings.
``prompts``
    A single record's life: read, create, update, rate, delete, count a use,
    and the two merges that end with one record where there were two.
``search``
    The one filtered, sorted, paged read the panel's list is built from.
``snippets``
    ``[[snippet]]`` bodies.
``taxonomy``
    Categories and tags — the filter rail.
``versions``
    Version history: list previews, read one, restore one.
``wildcards``
    The ``__wildcard__`` files and the resolver preview.

Handlers reach *down* only: :mod:`..utils` for the mechanics, :mod:`..config`
for constants, :mod:`..schemas` for their contract, and :mod:`..queries` /
:mod:`..indexing` for the read and write plumbing shared between groups. Two
route modules never import each other — anything both of them need has already
been moved down into ``queries`` or ``indexing``.
"""

from . import bulk, dupes, library, prompts, search, snippets, taxonomy, versions, wildcards

__all__ = [
    "bulk",
    "dupes",
    "library",
    "prompts",
    "search",
    "snippets",
    "taxonomy",
    "versions",
    "wildcards",
]
