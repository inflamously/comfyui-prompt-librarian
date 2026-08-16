# comfyui-prompt-library

Two independent nodes for keeping prompts out of your workflow presets.

| Node | What it is |
|---|---|
| **Prompt Library** (`PromptLibrary`) | The original. Two dropdowns, prompts grouped by category in `prompts.json`. Unchanged. |
| **Prompt Librarian** (`PromptLibrarian`) | The librarian view: fuzzy search, near-duplicate detection, tags, ratings, usage stats, version history, wildcards. |

The two share nothing — separate node classes, separate store files, separate HTTP routes,
separate web assets. Deleting either leaves the other working, and **the Librarian never reads or
writes `prompts.json`.** There is no migration; the new library starts empty.

---

## Prompt Librarian

### The node

Five widgets, and deliberately **no dropdowns**:

| Widget | Purpose |
|---|---|
| `text` | The prompt body. **This is the source of truth** and what the node outputs. |
| `prompt_id` | Hidden. Links this node to a library record so usage can be counted. |
| `seed` | Seeds `{a\|b}` wildcard resolution. Has `control_after_generate`. |
| `resolve_wildcards` | Turn wildcard expansion off to pass the raw template through. |
| `track_usage` | Turn usage counting off. |

Output is a single `STRING` named `text` — wire it into any CLIP Text Encode.

Because `text` is a normal serialized widget, **a workflow carries its prompt inside the `.json`**.
Open it on a machine with no library and it still renders and still runs; it just won't count usage
or show the record's label. That is also why there are no combo widgets: it sidesteps the entire class of
LiteGraph/Vue combo-reactivity problems the older node has to work around.

### The node and the panel are one field

The panel's prompt box and the node's `text` widget are **two views of the same value**.
Type in either and the other follows; the node's card preview follows too. Picking a prompt in
the rail loads it straight into the node — body *and* `prompt_id`, which is what keeps usage
counting honest.

The header carries a **⇅ linked** chip. Turn it off to browse, edit and save library records
without touching the node at all. The setting is remembered across reloads.

There is no `Load into node` button in the inspector — the binding *is* the push, so a button that
re-sent what the node already holds only invited the question of what it did differently. The two
explicit loads that remain are the ones the binding does not cover: activating a row in the rail
(Enter / double-click) and `Load into node` in the version history, which sends an old body to the
node without saving it.

Three rules decide who wins when both sides move at once:

- **On connect the node wins.** Opening the panel, or re-pointing it at another node, pulls that
  node's text in — it is what will actually render. With nothing selected it lands in the box as an
  unsaved buffer, ready for `Save as new`.
- **The caret wins.** Text arriving from the node is not applied while you are typing in the panel's
  box.
- **Selection is a commit, deselection is not.** Picking a row writes the node; clearing the
  selection, a background refresh, or merely opening the panel never does.

Binding to the node changes nothing about saving: text arriving from the node is an ordinary edit,
so it marks the record `edited` and still goes through the full dupe-and-staleness gate below.

### The librarian panel

Click **Open Librarian** on the node. The panel is a full-screen overlay:

- **Left rail** — fuzzy search over body + tags with a live hit count, tag filter
  chips, a `dupes only` toggle, `relevance | recent | most used | a–z` sorting, and a virtualised
  list. Each row shows its near-dupe count and, when you have a prompt selected, its `% match`
  against it — so duplicates are visible *before* you open anything.
- **Right pane** — the derived label, tags, the prompt text with char and token counts, the
  duplicate check panel, four stat tiles (used / last run / versions / rating), and the action bar.

Search supports operators: `tag:dance`, `-word` to exclude, and `"quoted phrase"`.

**Ctrl+S** (⌘S) saves from anywhere in the panel. ComfyUI never sees the chord — the key isolation
described under `keys.js` below stops every keystroke inside the overlay before the canvas can act
on it — and the browser's own *Save Page* dialog is suppressed too.

**Closing saves.** Escape, the `×` and a backdrop click all save first and then close; a panel with
nothing to write closes straight away. There is no `Discard unsaved edits?` prompt, because being
unable to dismiss the panel is a worse failure than a save you did not ask for. The two gates in
*Never a silent overwrite* below still apply: a near-duplicate or a record changed elsewhere opens
its dialog and the panel stays open, since those are the only cases where closing could quietly
damage the library. Whatever is in the box also survives in the per-record draft either way.

### Prompts have no names

You never name a prompt, because a name is not a fact about a prompt — it is a second, hand-typed
copy of what the body already says, and it goes stale on the first edit. What a row, a node face or
a version entry prints is **derived**: the terms this body has that the rest of your library does
not, by tf-idf over the same tokens the search index already keeps.

    a lone ballerina drifting through a ruined theatre, volumetric haze, 35mm
    → ruined theatre · 35mm

Two prompts that open with the same forty words of boilerplate still read apart, because the label
is made of the words only one of them uses. It is a *display* string and nothing else: it changes
when the library around it changes, nothing is stored by it, and nothing is looked up by it. The
search bar is how you find a prompt again — search the words you would have put in the name.

(A body with nothing distinctive to say, or one in a library too small to have an opinion, falls
back to its own opening words.)

### Never a silent overwrite

Saving runs a fresh duplicate check regardless of what the panel currently shows. If anything
scores at or above the threshold, the save **stops** and you get an explicit choice — compare,
merge into that one, keep both (which also stops that pair being flagged again), overwrite that
one, or `save anyway` behind a confirm that names every match. There is no default "just save".

Saves also carry the record's `updated` timestamp, so if another browser tab changed the same
prompt underneath you, the write is rejected with a conflict dialog rather than clobbering it.

### Duplicate detection

Similarity is character-level `difflib` ratio over normalized text, with a token-index prefilter so
it stays fast on a large library. The threshold is adjustable (80–99 %, default 90 %) and each match
comes with a readable summary of what differs, e.g.:

```
96%  ballet_drift_v2
     differs: "toward" → "towards", + volumetric haze
```

Note that the ratio penalizes length differences, so a given edit scores lower on a short prompt
than on a long one. If a pair you consider duplicates isn't showing, lower the threshold.

### Wildcards

Resolved at execution time, seeded so a given seed always produces the same output.

| Syntax | Meaning |
|---|---|
| `{a\|b\|c}` | pick one |
| `{3::a\|b}` | weighted — `a` three times as likely |
| `{2$$a\|b\|c}` | pick 2 distinct, joined with `, ` |
| `{1-3$$a\|b\|c}` | pick a random 1–3 |
| `__name__` | a random line from `wildcards/name.txt` |
| `[[snippet]]` | inline a saved snippet |
| `\{ \| \} \_ \[ \]` | escapes |

Nesting works (`{a|{b|c}}`). A missing wildcard file is left as literal text and reported — it never
fails a render. Put `.txt` files (one option per line, `#` for comments) in the `wildcards/` folder
next to the library file.

Editing a wildcard file changes what a fixed seed produces, so the node folds the wildcards folder's
state into its cache key — edit a file and dependent nodes correctly re-run.

### Other features

- **Version history** — every save that changes the body snapshots the previous one. Browse,
  diff against current, restore (restore is itself undoable), or push an old version to the node
  without saving.
- **Compare / merge** — word-level diff, side by side. Merging sums usage counts, unions tags, keeps
  the higher rating, and preserves the loser's body as a version.
- **Bulk operations** — checkboxes with shift-click ranges and `select all filtered`, then bulk
  delete, retag, or merge duplicate clusters. Destructive actions confirm with counts.

---

## Where data lives

```
<ComfyUI>/user/default/prompt-librarian/
├── library.json              the whole library
├── library.bak.json          previous version, rewritten on every save
└── wildcards/*.txt           your wildcard files
```

`library.json` is plain readable JSON, written atomically (temp file + rename) so an interrupted
save can't truncate it. Records look like:

```json
{
  "schema": 1,
  "settings": { "dupe_threshold": 0.90, "version_cap": 50 },
  "snippets": { "cine_lighting": { "body": "volumetric haze, 35mm", "updated": "..." } },
  "ignored": [["idA", "idB"]],
  "prompts": [{
    "id": "9f2c1b7e4a5d4f0e8c3b1a2d5e6f7a8b",
    "body": "make him dance ballet slowly drifting towards the camera, ...",
    "tags": ["dance", "camera-move"],
    "rating": 4, "used": 41,
    "last_run": "2026-08-11T19:03:22Z",
    "created": "...", "updated": "...",
    "notes": "", "pinned": false,
    "versions": [{ "body": "...", "ts": "...", "src": null }]
  }]
}
```

There is no `name`, and no derived label on disk either — a derived field written to a file is a
stored name again by another route. A record that still carries one from an older build is scrubbed
on load and written out of the file on the next save, versions included; no schema bump, because an
older build reading a scrubbed file just sees an unnamed record and derives a label for it, which is
what it would have done anyway.

Ids are random, not content hashes — two prompts with identical bodies must be able to coexist
until you merge them, and an id has to survive a body edit to keep the workflow link intact.

A corrupt or hand-broken `library.json` is never overwritten: the Librarian starts empty, logs, and
moves the bad file aside as `library.corrupt-<timestamp>.json` on the next save. A file written by a
*newer* schema loads read-only rather than being downgraded.

**Limits:** 100 000 characters per prompt, 50 versions (or 256 KB of version bodies) per record,
32 tags. Similarity compares the first 4 000 normalized characters.

**Not handled:** two ComfyUI instances sharing one user directory. Writes are per-record
last-writer-wins, with silent loss for the loser.

---

## Usage counting

`used` only increments when the node's `prompt_id` resolves **and** the text still matches the saved
body. Edit the text without saving and the counter deliberately stays put — the panel shows an
`edited` marker to explain why.

The reason is that `used` drives the "most used" sort and is summed when records merge, so it has to
mean "this exact saved body ran". Counting edited-but-unsaved text would skew both permanently with
no way to audit it.

---

## Install

Drop the folder in `ComfyUI/custom_nodes/` and restart. **No dependencies** beyond what ComfyUI
already ships — the whole thing is Python standard library plus vanilla JavaScript, with no build
step.

On start you should see `[prompt-librarian] registered 31 routes under /prompt_librarian`. Route
registration is isolated from the old node's, so a failure in one can't take down the other.

---

## Layout

One folder per domain — `<root>/<domain>` — and the two domains import nothing from each other
(enforced by the `Domains are independent` import-linter contract):

```
__init__.py                   node mappings, WEB_DIRECTORY, both route blocks

prompt_librarian/             the Librarian domain
  __init__.py                 exports PromptLibrarian
  node.py                     the node class
  api/                        31 routes under /prompt_librarian
    config.py                 prefix, capabilities, exception -> status table
    utils.py                  route table, guard, JSON envelope, coercion
    api.py                    one function per feature — the handlers
    registration.py           register(): the route table -> aiohttp
    schemas.py                what each endpoint takes and returns, as types
    openapi.py                those two -> an OpenAPI 3.1 document (pydantic)
  wildcards.py                {a|b} / __file__ / [[snippet]] resolution
  dedupe.py                   similarity cascade, dupe caches, word-level diff
  search.py                   inverted index, relevance scoring, filters, sorts
  labels.py                   what a record is called, derived from the corpus
  store.py                    schema, atomic I/O, CRUD, versions, merge, snippets

prompt_store/                 the OLD node's domain — untouched
  __init__.py                 exports PromptLibrary and the prompts.json helpers
  node.py                     the node class and its store

web/prompt_librarian/         the Librarian's frontend — one directory per feature
  index.js                    extension entry (the only file with import-time side effects)
  shared/                     h(), text/number formatting, timing, the singleton bag
  api/                        request primitive, lanes, caps, routes, meta cache
  node/                       the node's face, widgets, hydration, the node ⇄ panel binding
  modal/                      overlay shell, state store, key isolation, layers, target
  browse/                     the left rail: search, filters, virtualised list, bulk bar
  inspector/                  the right pane: fields, dupe panel, THE SAVE FLOW
  pickers/                    the popover primitive and its five consumers
  compare/                    diff, compare/merge and version-history dialogs
  librarian.css               scoped dark theme
web/prompt_store/             the OLD node's frontend — same split, four files
scripts/openapi.py            route table -> route listing or OpenAPI spec
tests/*.py                    338 tests, stdlib + pytest only
```

The modules inside `prompt_librarian/` are listed highest-layer first: each may import the ones
below it and none above, which is the `Librarian layers` contract in `pyproject.toml`. Inside a
domain the imports are relative (`from .store import STORE`); nothing reaches up out of a domain.

### Python — package

**`__init__.py`** (107 lines) — the only file both nodes touch. Exports
`NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS` for `PromptLibrary` and `PromptLibrarian`, and
`WEB_DIRECTORY = "./web"`. Then two *separate* `try/except` blocks: the first defines the old node's
four `/prompt_library/*` routes inline (`list`, `prompts`, `save`, `delete`); the second imports
`prompt_librarian.api` and calls `register()`. Separate guards are the point — a syntax error
anywhere in the librarian stack prints a skip line and leaves the old node's routes intact, and vice
versa. Both are further guarded on `PromptServer.instance` existing, so a headless/CLI import never
crashes.

Each domain's `__init__.py` is a thin facade over its own modules: `prompt_store` re-exports the
node plus the `prompts.json` helpers the routes above bind to, and `prompt_librarian` re-exports
only the node — the pack root imports `prompt_librarian.api` explicitly, inside its own guard, so a
failure in the route stack cannot take the node down with it.

### Python — the Librarian backend

**`prompt_librarian/store.py`** (1503 lines) — the library file and every mutation of it. Defines
`SCHEMA_VERSION`, the limit constants (`MAX_BODY_CHARS = 100 000`, `MAX_TAGS = 32`,
`VERSION_CAP = 50`, `VERSION_BYTES_CAP = 256 KB`, `DEFAULT_DUPE_THRESHOLD = 0.90`), the exception
hierarchy the API maps to error codes (`NotFoundError`, `BodyTooLargeError`, `ReadOnlyError`,
`ConflictError`, `SameRecordError`, `StoreWriteError`), path helpers (`user_dir`, `store_dir`,
`store_path`, `backup_path`, `wildcards_dir`), field cleaners (`clean_tags`, `clean_body`) and the
`_coerce` layer that makes a hand-edited file loadable — and that scrubs the removed fields
(`_REMOVED_FIELDS`: `category`, `name`, plus `categories` at the top level) off anything still
carrying them.
The bulk is `class LibrarianStore`: lock-guarded load/save (temp file + `os.replace` with retries
for transient Windows locks, `.bak.json` rewritten each save, corrupt files moved aside rather than
overwritten, newer-schema files loaded read-only), a monotonic `rev()` used for cache invalidation,
`on_change` callbacks plus websocket `_notify`, then CRUD (`create`, `update`, `set_rating`,
`delete`, `record_usage`), bulk ops (`bulk_delete`, `bulk_retag`, `bulk_merge`),
versions (`versions`, `version_previews`, `restore_version`, `_trim_versions`), `merge` /
`merge_new`, taxonomy (`tags`, `taxonomy`), snippets, the ignored-
pair list (`ignore_pair` / `is_ignored`), and `export_raw` / `import_raw`. Ends with the module-level
singleton `STORE`.

**`prompt_librarian/search.py`** (907 lines) — stdlib-only, knows nothing about aiohttp, ComfyUI or the
file format; it takes an iterable of record dicts or anything with `list_all()` + `rev()`. With no
name to match, **this module is the whole of how a library is navigated**, so the scoring weights
are module constants and worth reading before they are changed: `W_TAG 2.0`, `W_BODY 1.0` and
`W_HEAD 1.5` — a bonus on the body's first `HEAD_TOKENS` words, which inherit the role the name
weight used to play, since a prompt says what it is about up front and qualifies it afterwards.
Then phrase bonuses, popularity/recency nudges, and the exact/prefix/infix tiers. Provides
`normalize`, `tokenize`, `preview`, the `Doc` and `SearchIndex` dataclasses,
`build_index` / `get_index` / `invalidate_index`, the query parser (`ParsedQuery`, `parse_query`,
handling `tag:`, `-exclude` and `"quoted phrases"`), `score_doc`, the filter and sort passes
(`relevance | recent | most_used | az`, all sorting and tie-breaking on the body's opening words),
and the public `search()` returning a page dict. `SearchIndex` also answers the corpus half of
`labels.py`: `postings[token]` already *is* the set of records containing a token, so `df()` is a
`len()` and nothing extra is counted; `label_of(pid)` memoizes per index and the cache is dropped
wholesale on any write, because one added record can change every label.
Timestamps are compared as plain ISO strings — nothing here parses a date.

**`prompt_librarian/labels.py`** (336 lines) — what a record is *called*, computed and never
stored. Pure and stdlib-only, one layer below `search.py`: the index owns the document frequencies,
this module owns what to do with them. `label_for(body, df, ndocs)` picks the `LABEL_TERMS` most
distinctive terms of a body by tf-idf, merges the ones that were adjacent in the body back into
phrases (`ruined theatre`, not `ruined · theatre`), renders them in body order and caps the result;
`head_label` is the fallback for an empty corpus or a body of pure boilerplate, and is mirrored
character-for-character by `headLabel` in `web/prompt_librarian/shared/text.js` so a draft's handle
does not jump when it is saved. The idf is smoothed (`df + 0.5`) on purpose: unsmoothed it is
exactly zero for a term in *every* document, which in a one-record library is every term — and a
library's first prompt would be the only one that never got a real label. `term_tokens` folds a
surface word exactly as `search.normalize` does, splits included, and a word that splits is scored
by its rarest piece.

**`prompt_librarian/dedupe.py`** (758 lines) — near-duplicate detection and diffing, also stdlib-only.
`sim_norm` produces the normalized comparison text (capped at `SIM_MAX_CHARS = 4000`), `length_ok`
is the cheap length prefilter, `ratio` is the cascaded `difflib` real-quick/quick/full ladder.
`DupeIndex` / `build_dupe_index` provide the rare-token blocking index (`RARE_TOKENS`, `DF_ABS`,
`DF_FRAC`, `OVERLAP_FRAC`) that keeps a large library fast, backed by three LRU caches with
`invalidate(rev)` and `cache_stats()`. Public surface: `find_similar` (one vs N), `dupe_counts` and
`page_dupe_counts` (N vs N, plus connected-component clustering via `_components`), `dupe_ids`, and
`patch` for incremental updates after a single-record write. The diff half is `diff_tokens`
(word-level opcodes, capped), `diff_summary` (the readable `"toward" → "towards", + volumetric haze`
line, using real curly quotes and arrows since the UI renders the payload verbatim) and `compare`.

**`prompt_librarian/wildcards.py`** (662 lines) — the `{a|b}` / `__file__` / `[[snippet]]` resolver. No
filesystem access at import time. Escapes (`\{`, `\|`, `\}`, `\_`, `\[`, `\]`) are swapped for
private-use sentinels `U+E000..U+E005` first, so the rest of the pass can treat every remaining
metacharacter as syntax without a hand-written parser; the innermost-brace regex is then applied
repeatedly, peeling one nesting level per round. Bounded by `MAX_DEPTH = 10`, `MAX_PASSES = 20` and
`MAX_OUTPUT = 200 000` chars, so a self-referencing wildcard file degrades to literal text instead
of hanging the prompt worker. Contains `_safe_name` (the path-traversal guard), the `WildcardFiles`
cache with its `FILES` singleton, `signature()` (folded into the node's cache key), `names()`,
option parsing with weights (`3::`) and pick-N (`2$$`, `1-3$$`), the seeded `random.Random` picks,
and the public `resolve` / `resolve_verbose` / `has_wildcards` / `referenced_names`.

**`prompt_librarian/api/`** (1 276 lines, spec modules aside) — the 31 aiohttp routes under `/prompt_librarian`, split
four ways: `config.py` (the prefix, `CAPABILITIES`, `_ERROR_MAP`), `utils.py` (the route table and
everything mechanical), `api.py` (one function per feature — the handlers), `registration.py`
(`register()` alone). `aiohttp` is imported on first use, never at module scope, so tests and
`scripts/openapi.py` can import the package without it. Every read is GET, every write is POST (no
PATCH/DELETE, no path params — that survives ComfyUI's `/api` prefix rewriting). `_route` collects
handlers into `_ROUTES`; `_guard` wraps each one so a backend bug returns `500 {"error", "code"}`
instead of taking down the server; `_ERROR_MAP` turns store exceptions into stable codes the
frontend branches on; every response merges in `{"rev": STORE.rev()}`. Anything that serializes JSON
or scans every record goes through `_offload` to a thread; dict/index lookups run inline. Routes:
GET `ping`, `search`, `prompt`, `versions`, `version`, `taxonomy`, `dupes/all`, `wildcards`,
`snippets`, `export`; POST `meta`, `dupes`, `compare`, `resolve`, `create`, `update`, `rate`,
`delete`, `usage`, `bulk/{delete,retag,merge}`, `merge`, `merge_new`, `versions/restore`,
`dupes/ignore`, `snippet`, `settings`, `import`. Also exposes a `CAPABILITIES` dict the
frontend feature-detects against.

**`prompt_librarian/api/schemas.py`** (648 lines) + **`openapi.py`** (198) + **`scripts/openapi.py`**
— the route table, described. Every `@_route` names an OpenAPI operation id, a one-line summary and
three dataclasses: what the query takes, what the body takes, what comes back.

```python
@_route("get", "/versions", op="listVersions",
        summary="Version history of one record as previews, never full bodies.",
        query=schemas.ListVersionsQuery, returns=schemas.VersionsResponse)
```

`schemas.py` is plain stdlib — dataclasses, `Literal`, `X | None` — and imports nothing, so the pack
carries ~60 class definitions at startup and no third-party code ever. A field with no default is
required; a default is the handler's own fallback (`_int(params.get("chars"), 160)` -> `chars: int =
160`); an attribute docstring becomes the field's description in the spec. Every response inherits
`Envelope`, which is where the `rev` merged into every payload comes from.

`openapi.py` holds no schema-building code at all: pydantic's `TypeAdapter(T).json_schema()`
generates every schema, `$ref`, enum, nullable and default, and what is left is assembly — hoisting
`$defs` into `components/schemas` and splitting a query dataclass into `parameters[]`. pydantic is a
`dev` extra; ComfyUI never imports this module, and the route listing does not need it either:

```bash
python3 scripts/openapi.py                  # every route, id and types, as text — stdlib only
python3 scripts/openapi.py -o openapi.json  # OpenAPI 3.1, needs pip install -e ".[dev]"
```

The handlers take a bare `request` and read `data.get("body")`, so nothing can be introspected out
of them — `schemas.py` is a parallel declaration, and keeping it true to the handlers is a review
question. `tests/test_openapi.py` covers the mechanical half: a route with no types, a response that
skips the `rev` envelope, a duplicate operation id, an unresolvable `$ref`, a query type that nests
a model, and the two tables declared twice (`Capabilities`, the error-code enum) drifting from the
live `CAPABILITIES` / `_ERROR_MAP`. Two more assert `Prompt` and `Settings` still match what the
store actually builds.

**`prompt_librarian/node.py`** (222 lines) — the node class. `INPUT_TYPES` is a pure dict literal (no
disk, no store, no combos) because it is called on every `/object_info` request: `text` multiline
STRING, `prompt_id` STRING, `seed` INT with `control_after_generate`, `resolve_wildcards` and
`track_usage` BOOLEANs, each with a tooltip. `run()` resolves wildcards inside a try/except that
falls back to the raw text — a wildcard bug must never fail a render — counts usage against the
*raw* widget text (never the resolved output), and returns both the STRING result and a `ui` dict
(`text`, `prompt_id`, `counted`, `chars`, `used`, `missing`, `warnings`) that the panel reads to
show what the seed actually produced. `IS_CHANGED` hashes text + seed + `resolve_wildcards` +
`prompt_id` — deliberately not `NaN`, and deliberately excluding `track_usage` since it changes
bookkeeping, not output — and folds in the wildcards-folder signature only when the text actually
contains a wildcard form. `_seed_int` coerces a bad widget value instead of raising.

### Web — the Librarian frontend

The frontend mirrors the Python side: **one directory per domain, one file per feature**. Every
module under `web/prompt_librarian/` is inert on import — ComfyUI loads every `.js` under the web
directory as an extension, so it is exports and `const` data only, and `index.js` is the single file
allowed a side effect.

**`web/prompt_librarian/index.js`** (122 lines) — the extension entry: one
`app.registerExtension({name: "prompt-librarian.ui"})`, one stylesheet injection, one `nodeCreated`
hook. It captures ComfyUI's `app` onto the shared singleton bag (nothing else imports this file —
that would re-run `registerExtension` under a second cache-busted URL), builds the node face, adds
`Open Librarian`, and drives the three hydration triggers. `modal/` is imported lazily inside a
try/catch: a missing panel logs once and the node still works.

**`node/`** (4 files, 962 lines) — everything attached to the node itself. `widgets.js` owns the two
widget names and hides `prompt_id` (it must stay serialized — that string is the only link between a
workflow and a library record — but has no business taking a row on the canvas). `face.js` builds the
face in two tiers: a `.pl-node-card` DOM widget when `addDOMWidget` exists **and** the element is
verified to have mounted one frame later, falling back to plain button widgets otherwise; `open` is
passed in rather than imported, which is what keeps the entry out of the import graph. `hydrate.js`
retries until the widgets exist. `bind.js` is the node ⇄ panel binding and the only module that
touches a LiteGraph widget's internals: `writeNodeText` is the single write path (value first, then
callback, and it also sets the backing `<textarea>` and dispatches a synthetic `input`, because
assigning `.value` from JS fires no event and the on-canvas widget would keep painting stale text),
and `bindNode` observes in three independent, individually optional layers — an `input`/`change`
listener on that element, a chained `Object.defineProperty` over `widget.value`, and `poll()` driven
by the modal's existing 1 s heartbeat — because which of them exists depends on a frontend generation
we cannot detect. The interception **chains onto the original descriptor** rather than replacing it:
on the legacy frontend `value` is already an accessor over `inputEl`, and a plain data property on top
silently disconnects the widget from its own element. Echoes are killed in one place for all three
layers by `lastSeen`, the last value written or observed. `bindNode` reference-counts its subscribers,
so the node card and the panel can both observe one node, and `unbind` restores exactly the descriptor
it found.

**`shared/`** (9 files, 681 lines) — dependency-free helpers, no ComfyUI import. `dom.js` (the `h()`
hyperscript, with a `DIRECT_PROPS` set for props that must be assigned rather than `setAttribute`d,
plus `append` / `clear` / `cls`), `text.js` (grapheme-aware `charCount` / `truncate` / `firstLine`,
`estimateTokens`, `stars`), `format.js` (`relTime`, `fmtInt`, `escapeQuery`), `timing.js` (`debounce`,
`rafThrottle`), `styles.js` (`ensureStyles`, resolving the stylesheet URL off `import.meta.url` rather
than guessing the mount point), `singleton.js` (the `singleton` / `singletonBag` registry that
survives a module re-import, and `warnOnce`), `widgets.js` (`setComboValues`, duplicated in behaviour
from the old node rather than imported from it so the two domains stay independently deletable), and
`index.js` — the barrel `ctx.dom` is built from.

**`api/`** (6 files, 659 lines) — the transport. `request.js` is the only module in this domain
besides the entry that imports from ComfyUI: it uses `api.fetchApi` so the base URL and any
reverse-proxy prefix apply, and it checks the response content-type before parsing (an unregistered
route answers with an HTML 404 page, and `res.json()` on that throws a SyntaxError about "<" — an
unreadable error for the most likely real-world failure). It exports `ApiError` and the `ABORTED`
sentinel, since a superseded call is not an error and no call site should need an AbortError
try/catch. `lanes.js` coalesces per concern using both an `AbortController` and a sequence number
(abort is not synchronous with resolution, so the sequence guard is what actually closes the
type-fast-get-stale-results race). `caps.js` is optimistic-by-default feature detection, `routes.js`
is one method per route, and `meta.js` batches every node face on the canvas into one `POST /meta`.

**`modal/`** (14 files, 1845 lines) — the shell and the app's spine. `state.js` (the singleton
instance and the `getState` / `setState` / `subscribe` store), `shell.js` (the header / rail /
inspector / footer DOM, the target picker, click-outside, the responsive switch), `layers.js`
(`pushLayer` / `popLayer` / `topLayer`, `toast()` and `confirmDialog()`), `target.js` (resolution BY
ID on every call — holding a node reference survives the node being deleted — and `loadIntoNode`),
`binding.js` (the `⇅ linked` toggle and its `localStorage` preference, plus `attachBinding` /
`detachBinding` / `syncBinding`, reconciled on the same 1 s heartbeat that re-resolves the target, so
a re-pointed or re-created node is picked up without a hook of its own; the seed direction on attach
is node → panel, deliberately, because the node holds what will actually render), `drafts.js`,
`data.js` (taxonomy, header, `refreshAll`), `panes.js` (the lazy try/catch mounts of `browse/` and
`inspector/`, so a broken module degrades to a placeholder rather than an empty modal), `close.js`
(save-on-close and the teardown of everything that could outlive the modal), `ctx.js` (the shared
object every pane is handed) and `index.js` (`openModal`, plus the public re-exports).

`close.js` reaches the inspector through two duck-typed hooks on `ctx` — `isDirty()` and
`requestSave()`, the latter resolving to `saved | clean | blocked | failed | busy`, with only the
first two clearing the modal to close. They are compared as plain strings because `modal/` must
never import from `inspector/`, which `panes.js` loads lazily and may legitimately be absent.

`keys.js` is the file to read before touching anything key-related. It installs the **key isolation**
guard — a window-capture listener that calls `stopImmediatePropagation()` on every key event
originating inside `.pl-root`, so ComfyUI's global shortcuts (Delete removes the node, Ctrl+Z undoes
the graph, Space pans the canvas) can't fire while you type — and re-delivers those events on its own
key bus. That is why a plain `addEventListener("keydown", …)` is dead code everywhere else in the
panel. The guard only ever calls `stopPropagation`, never `preventDefault`, because text entry and
IME composition are default actions rather than listeners; the two sanctioned exceptions both live in
`shell.js`, where Escape and Ctrl+S prevent a browser default that is not text entry.

**`browse/`** (8 files, 1249 lines) — the left rail: search box with live hit count, filter chips,
`dupes only`, sort tabs, the virtualised list and the footer/bulk bar. `paged-source.js` handles
200-record pages and the skeleton rows for holes, `virtual-list.js` the recycled window (and
`compare/versions.js` reuses it for long histories), `rows.js` the row markup and its textContent-only
paint, `selection.js` the two modes — explicit ids, or the abstract "all filtered", which stores the
QUERY rather than 1 284 ids because that is the only shape that scales and exactly what the bulk
endpoints accept — `bulk.js`, `chips.js`, `picker.js` and `index.js` (`mountList`). All search is
server-authoritative: there is no local filtering here by design, because the `% match` and near-dupe
badges are computed by the backend for the current page and a locally-filtered list would show rows
whose badges disagree with it.

**`inspector/`** (11 files, 2259 lines) — the right pane: the derived label, tags, the prompt textarea
with char/token counts and the `edited` marker, the duplicate-check panel, the four stat tiles and the
action row. The feature files share one mutable `pane` object rather than a closure, which is what
lets each of them live in its own file while still reading and writing the same edit buffer; only
`index.js` creates it. `view.js` is the markup (built once; every later update is a value write),
`dupes.js` the live check and its threshold control, `drafts.js` the per-record sessionStorage drafts,
`neighbours.js` every lazy reach into `pickers/` and `compare/` (each degrading to a toast),
`layers.js` the pane's own popovers and inline dialogs, `records.js` the pure payload shapes, and
`helpers.js` the helper table with its fallbacks.

Its half of the node binding is three hooks and no restructuring: `afterEdit()` pushes the buffer
through an rAF-coalesced `pushBody` (so a fast typist costs one canvas repaint per frame, not per
keystroke), `setBody(text, {fromNode})` marks the inbound direction and yields to whichever textarea
holds the caret, and `adoptRecord(rec, {push})` writes body **and** `prompt_id` — opt-in, and set only
on a user selection or a save, never on deselect, a background refresh, or the initial paint. The echo
guard is `lastInbound`, a value rather than a flag, because the push is coalesced to the next frame
and any "currently applying" marker would already be clear by the time it runs.

`save.js` is the reason the pane exists: not-dirty check → staleness check → dupe gate (always re-run
on save, and deliberately not through the lane, so a keystroke landing mid-save cannot abort it) →
commit (`create`, or `update` with `expect_updated`, with a 409 re-entering the staleness step) →
adopt the server's record as both `current` and `baseline`. Its two dialogs are built inline through
the pane's own layer host rather than through `compare/`, so the safety property still holds on an
install where `compare/` failed to load. Never `innerHTML` — prompt bodies are user data.

**`pickers/`** (11 files) — one popover primitive, `popover.js`, serving four consumers:
`tags.js` (with `normalizeTag`, mirroring the store's `clean_tag`), `threshold.js`,
`snippets.js` and `wildcards.js`, all over the shared `menu.js` body. Plus `caret.js`
(`insertAtCaret`), `tokenize.js` (the wildcard syntax lexer, deliberately aligned with
`wildcards.py` — a highlight that disagrees with the resolver is worse than no highlight) and
`mirror.js`, the highlight layer rendered behind the textarea, which only lines up if every
typographic property matches exactly and which tears itself down when its own one-frame height
self-check says it doesn't. `common.js` carries the `bindKeys` helper and restates the isolation rule.

**`compare/`** (6 files, 1994 lines) — the three big overlays. `diff.js` (`renderDiff()`, the
split/unified primitive shared by all of them, capped at `MAX_TOKENS_PER_SIDE = 5000` with a visible
notice rather than a silent truncation), `compare.js` (`openCompare()`, used for dupes, diff-vs-saved
and versions), `merge-editor.js` (the editable "merge → new" union) and `versions.js` (two-pane
version history with restore). Every key handler goes through `common.js`'s `bindKey()` on the modal's
key bus, per the isolation rule above.

**`web/prompt_librarian/librarian.css`** (1836 lines) — the scoped dark theme. Tokens on `.pl-root`,
then sections for the overlay, header, rail, filter chips, virtual list (including the skeleton rows),
inspector, mirror/highlighting, stat tiles, action bar, dialogs, diff panes, toasts and popovers.
Everything is scoped under `.pl-root` / `.pl-node-card` with `pl-`-prefixed class and keyframe names,
and includes an inbound-defence block restating inherited properties so a stray ComfyUI rule can't
reach in.

### Tests

`tests/` runs on pytest with no ComfyUI and no third-party imports.

| File | Tests | Covers |
|---|---|---|
| `conftest.py` | — | Injects a stub `folder_paths` into `sys.modules` **before** `prompt_librarian.store` imports, and an autouse fixture repoints it at each test's `tmp_path`. Also puts the pack root on `sys.path` so the `from prompt_librarian import search` form works. No test can reach a real user directory or the old node's `prompts.json`. |
| `test_store.py` | 48 | Schema coercion (including the removed-field scrub), atomic write and backup, corrupt/newer-schema handling, CRUD, conflicts, bulk ops, version trimming, merge semantics, taxonomy, snippets, ignored pairs. |
| `test_search.py` | 44 | Free-standing (plain dict fixtures, no store): tokenizing, index building, query operators, scoring, filters, all four sorts, paging. |
| `test_labels.py` | 29 | Also free-standing: distinctive-term selection, stopwords and the digit exception, phrase merging, ordering, caps, the body-head fallback, the smoothed idf that keeps a one-record library labelled, and that `term_tokens` folds exactly as `search.normalize` does. |
| `test_dedupe.py` | 39 | Also free-standing: ratio cascade vs raw `difflib`, length prefilter, blocking index correctness, clustering, cache invalidation, diff opcodes and summaries. |
| `test_wildcards.py` | 63 | Determinism, nesting, weights, pick-N, escapes — and the three guards that matter for not hanging a render worker: path traversal, cycles, output size. |
| `test_api.py` | 68 | Drives handlers directly with a stub request (`.rel_url.query` + async `.json()`), so no server is stood up; skips wholesale if aiohttp is absent. Route table, error-code mapping, `rev` propagation. |
| `test_openapi.py` | 17 | Drift guards on the generated spec: every route typed, every response inheriting the `rev` envelope, every operation id unique, every `$ref` resolvable, and `Capabilities` / `Prompt` / `Settings` / the error codes still matching the live tables. Needs no aiohttp; skips wholesale without pydantic. |
| `test_node.py` | 30 | The load-bearing node properties: `INPUT_TYPES` is pure (no disk, no combos), `run()` never fails a render, `IS_CHANGED` responds to the right inputs, and usage counts only a run of the *saved* body. |
| `test_route_contract.py` | 34 | The one test that spans both languages. Runs `tests-js/tools/dump-routes.mjs`, which invokes all 30 `API` methods against a recording transport, and asserts the resulting `(method, path)` set equals the Python `_ROUTES` table in **both** directions. Extraction is by execution, not regex, and reads neither `openapi.json` nor pydantic. Skips with a reason when `node` is absent. |

### JS tests — `tests-js/`

`node --test` (Node 22's built-in runner) with `jsdom` as the only dependency. No build step, no
config file. **`npm install` on a filesystem without symlinks — a Windows drive, a `fuseblk` mount —
needs `npm install --no-bin-links`**; nothing here runs a package binary, so the shims are not missed.

The whole tree is exercised through a **mirrored mount**: `web/` is copied into a temp directory laid
out exactly as ComfyUI serves it (`/extensions/<pack>/…` beside a stub `/scripts/`), and
`harness/mount.js`'s `imp()` is the only way a test reaches production code. Importing `web/` in place
would resolve the four hardcoded `../../../scripts/app.js` walks against the repo and never notice a
layout change. (Copied, not symlinked: Node resolves ESM against a module's *real* path, so a symlink
defeats the whole point.)

| File | Tests | Covers |
|---|---|---|
| `structure.test.js` | 8 | Tier 0, no jsdom. Every module imports through the mirror; the four `../` depths land on the stubs; only the declared files touch ComfyUI and the two domains stay independent; **`INERT ON IMPORT` as a runtime assertion** — imported with no `document`/`window` at all, the singleton bag must hold exactly `lanes` and `caps`; `api.fetchApi` is the only network call site. |
| `devharness.test.js` | 8 | The dev playground's own source, which nothing else would notice a typo in until the page was opened. |
| `unit/records.test.js` | 32 | `inspector/records.js` — zero imports, and `sig()` is the dirty comparison the whole close flow rests on. |
| `unit/text-format.test.js` | 44 | Grapheme safety (both the `Intl.Segmenter` and `Array.from` branches), label derivation, `relTime` with `now` injected, `escapeQuery` round-tripping. |
| `unit/tokenize-timing.test.js` | 22 | The wildcard grammar against its Python counterpart, including the two deliberate divergences; `debounce`/`rafThrottle` including `cancel()`, which `closeModal()` relies on. |
| `dom/close-save.test.js` | 18 | **Save-on-close.** The five-status matrix (`saved`/`clean` close; `blocked`/`failed`/`busy` stay open), the `it.closing` re-entry latch against Esc-mashing, the close button disabled for the round trip, all three close routes, the drag-to-backdrop that must *not* close, and full teardown. |
| `dom/shortcuts.test.js` | 9 | Ctrl/Cmd+S: fires once, `e.repeat` guarded, skipped while a layer is open, narrow mode brings the editor forward, `preventDefault` for the chord but never for a plain letter. |
| `dom/key-isolation.test.js` | 9 | The pack's stated top hazard, against a simulated ComfyUI that registers document-capture listeners first: nothing inside `.pl-root` escapes, everything outside still works, typing is never `preventDefault`-ed, and closing removes **both** layers. |

Writing these turned up one live bug, since fixed: `sig()` joined the tags with `""`, so
`["cat","dog"]` and `["catdog"]` produced the same signature — `isDirty()` reported false, `save()`
returned `"clean"`, and save-on-close discarded the retag without a word. It now stringifies the
sorted tag array, which no separator could have made safe (`clean_tag()` only collapses whitespace).

What jsdom **cannot** check, and where no test should pretend to: it has no layout engine, so every
`getBoundingClientRect` is zero. `pickers/mirror.js` caret measurement, popover positioning and
`browse/virtual-list.js` scroll maths are therefore untested on purpose — an assertion there would
pass forever, including after the code broke. The same goes for CSS: jsdom does not cascade, so the
one style invariant worth pinning (`.pl-dirty` is gone) is a grep in tier 0, not a DOM assertion.

### The dev playground — `scripts/devserver.py`

```
python scripts/devserver.py --seed 2000     # then open http://localhost:8189
python scripts/devserver.py --check         # assert everything and exit; CI-able
```

Run it with **the Python you start ComfyUI with** — it needs `aiohttp`, which ComfyUI provides and
which is deliberately not a runtime dependency of this pack. A bare system Python usually lacks it;
the script says so up front and names the interpreter it was run with. `pip install aiohttp` in that
interpreter works too.

Mounts the real 29 routes against a real `LibrarianStore`, serves the real `web/` tree at ComfyUI's
URL layout, and supplies stub `/scripts/{app,api}.js` from `devharness/`. Edit a file under `web/` and
refresh; with `--reload` the page reloads itself and a `.py` change re-execs the server in ~300 ms.
ComfyUI is never started.

The API is mounted under `/api` **only**, never also at root — `request.js` exists because a bare
`fetch("/prompt_librarian/…")` works on a default install and 404s behind a proxy, and answering both
prefixes would hide exactly that bug. `--api-prefix ""` simulates the other install.

`devharness/` is checked in rather than generated, because the fake node is not boilerplate: it is
where the widget shapes `node/bind.js` defends against are written down, and the UI can switch
between them (`legacy` / `domwidget` / `opaque`), make `addDOMWidget` absent, throw, or accept and
never mount, delay the widgets to reproduce the `nodeCreated`-before-widgets quirk, and select which
of the four graph probes `modal/target.js` will find. Those defences are otherwise unreachable.

**It cannot touch a real library.** Four independent layers have to fail first: the explicit
`LibrarianStore(path=…)` override, a stub `folder_paths` injected before the pack imports, a pinned
`_FALLBACK_USER_DIR`, and a refuse-to-start guard that rejects anything shaped like a real library,
anything outside `.devserver/`, and any pre-existing file the server did not create. The store is then
repointed **by object identity** across every module attribute — `wildcards.py` binds it as `_STORE`,
which a name-based sweep misses — and an incomplete swap is fatal rather than silent.

### The old node — untouched

**`prompt_store/node.py`** (146 lines) — the original `PromptLibrary` node and its
`{category: [text, ...]}` store at `<user>/default/prompt-library/prompts.json`. Holds
`_load_prompts` / `_save_prompts` (tolerating the older flat `{name: text}` format), `_category_names`
(which returns `["<empty>"]` because an empty combo list breaks the frontend), `_save_target`,
`_add_prompt`, and the node class with its `VALIDATE_INPUTS` returning `True` unconditionally to
bypass server-side validation of a JS-populated combo.

**`web/prompt_store/`** (4 files, 269 lines) — its frontend, split the same way: `index.js` registers
`prompt-library.ui` and owns the node hook, `labels.js` builds combo labels by stripping the common
token prefix/suffix across a category's prompts, `widgets.js` is the combo-reactivity shim, and
`api.js` holds the three `/prompt_library/*` calls. Nothing in the Librarian imports from any of them,
and nothing here imports from the Librarian — deleting either directory leaves the other working.

Every module in both domains is inert on import, because ComfyUI loads every `.js` under the web
directory as an extension. All CSS is scoped under `.pl-root` / `.pl-node-card` with `pl-` prefixed
class and keyframe names, so nothing leaks into ComfyUI's own UI.

The node face uses `addDOMWidget` when the installed frontend has it, and falls back to plain button
widgets when it doesn't — verified by checking the element actually mounted, since some frontends
accept the call and silently drop it. `Open Librarian` exists either way.

## Tests

```
python3 -m pytest tests/ -q      # 372 tests, no ComfyUI required   (Windows: python / py)
npm install --no-bin-links       # jsdom, once (drop the flag if symlinks work)
npm test                         # 151 JS tests, no ComfyUI and no browser
ruff check .                     # style, imports, complexity
lint-imports                     # the layer + independence contracts
python3 scripts/openapi.py       # the route table, as a listing or a spec

python3 scripts/devserver.py --seed 2000   # the whole UI at localhost:8189
```

On Windows the interpreter is `python` (or `py`), not `python3` — and for `devserver.py` it must be
the one ComfyUI runs on, see below.

Both suites run in about a second and neither needs ComfyUI. `npm test` skips nothing; the pytest
route-contract test skips with a reason if `node` is not installed.

`tests/conftest.py` stubs `folder_paths` at a temp directory, so the suite never touches a real user
directory. `lint-imports` reads its contracts from `pyproject.toml` and analyses the two domain
packages, which is why they are packages rather than loose modules — the pack root's directory name
is not a valid Python identifier and cannot be imported outside ComfyUI.
