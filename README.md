# comfyui-prompt-library

Two independent nodes for keeping prompts out of your workflow presets.

| Node | What it is |
|---|---|
| **Prompt Library** (`PromptLibrarian`) | The original. Two dropdowns, prompts grouped by category in `prompts.json`. Unchanged. |
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

  **Near-duplicates are folded into one row.** Four copies of a prompt are a single row badged
  `4 copies`, not four rows that each claim three near-duplicates; click the row (or its ▸) to open
  the cluster in place, ← / → on the keyboard. The cluster keeps the position its best member would
  have had under the current sort, so folding never reorders anything. Ticking a collapsed cluster
  ticks every prompt in it — open it first to act on just one. The hit count stays in *records*, so
  it always agrees with what a bulk action will touch.
- **Right pane** — the derived label, tags, the prompt text with char and token counts, the
  duplicate check panel, four stat tiles (used / last run / versions / rating), and the action bar.

**Saved-prompt autocomplete** is enabled in the panel editor. As soon as you type two characters,
it requests individual words and short comma/newline-separated phrases from current saved bodies.
Suggestions contain one to three words; longer fragments contribute individual words only:
`vol` can offer `volumetric` and `volumetric lighting`. Up/Down selects, **Enter** or a click accepts,
and **Escape** dismisses suggestions. **Shift+Enter** inserts a newline; Enter also inserts a newline
when no suggestions are open. **Tab** keeps normal focus navigation. Phrase completion is
available at the end of a fragment; acceptance preserves its surrounding spaces and separators.
Suggestions pause during IME composition and text selection, and editing still works offline.

The vocabulary follows saves, edits, imports, merges, version restores, and deletions. It excludes
tags, notes, historical versions, snippets, and unsaved drafts, and treats template syntax literally
without opening wildcard files. Unicode normalization and case folding remove duplicates; ranking
uses the number of source prompts, then alphabetical order. Existing SQLite libraries backfill
in bounded batches within one transaction, and subsequent saves index only changed bodies. The
versioned `autocomplete_keywords` and `autocomplete_sources` tables rebuild automatically to remove
previously learned long sentences. They are derived data and stay out
of JSON exports. No dictionary or model is needed.

`GET /prompt_librarian/autocomplete` accepts `word_prefix`, `phrase_prefix`, and `limit` (default 8,
clamped to 1–20). The response envelope contains `suggestions` with `text`, `scope` (`word` or
`phrase`), and `source_count`. Prefix matching is literal and uses the normalized keyword index.

Search supports operators: `tag:dance`, `-word` to exclude, and `"quoted phrase"`.

**Ctrl+S** (⌘S) follows the active surface: while the panel is open it saves the prompt and
suppresses the browser's *Save Page* dialog; after the panel closes, the untouched chord belongs to
ComfyUI's `Comfy.SaveWorkflow` command. The key isolation described under `modal/input/keys.js` below also stops
every other keystroke inside the overlay before the canvas can act on it.

**Closing saves.** With suggestions dismissed, Escape, the `×` and a backdrop click all save first and then close; a panel with
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
one, or `save anyway`. There is no default "just save".

`save anyway` is the *last* dialog, not the first of several: it writes the record and mutes every
pair it just listed, so the same matches never re-open this gate. (Closing the modal saves, so
without that the dialog came back on every close.) Muting is per pair — a genuinely new
near-duplicate still stops the save.

**A mute silences this dialog and nothing else.** It is not a claim that the duplicate went away,
so the list still folds the cluster, the badge still counts it, and the duplicate panel still lists
it — marked `muted`, with an `un-mute` button that hands the pair back to the gate. Subtracting
muted pairs from the counts is what used to make a library of four identical prompts report
`1 near-dupe` on every one of them: a number that corresponded to nothing on screen, arrived at by
four `keep both` clicks nobody could see or undo.

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
├── library.sqlite3           authoritative library + search index
└── wildcards/*.txt           your wildcard files
```

There is one authoritative persistent storage file. SQLite may create transient `-wal` and `-shm`
companions while a connection is open. Complete prompt records, versions, settings, snippets,
muted duplicate pairs, tags and the search projections all live in `library.sqlite3` and change in
one transaction.

Saving is proportional to the prompts changed. A single edit updates one record plus its tag/token/
FTS rows; it never parses or rewrites the rest of the library. Search asks SQLite for candidate
current bodies; an empty browse loads only 160-character row previews and basic metadata, never every
full prompt or its version history. Deletes can leave free database pages; the Storage dialog offers
**Optimize storage** (SQLite `VACUUM`) only when enough space is reclaimable. It is never run during
a normal save.

JSON remains the backup and interchange format. **Export JSON** streams the schema-1 envelope to a
file in bounded batches; **Import JSON** uploads to a temporary file and supports safe merge or
replace. Exported records look like:

```json
{
  "schema": 1,
  "updated": "2026-08-26T10:32:13Z",
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

Old `library.jsonl` and `library.json` files are migration sources, not live storage. When one exists,
the Storage dialog offers an explicit migration. Migration merges prompts/snippets/muted pairs,
keeps the current SQLite settings, gives colliding prompt ids deterministic new ids, records an
idempotency marker, and leaves the source file untouched. Neither source is read automatically
during ordinary startup. A database declaring a newer schema loads read-only rather than being
downgraded; an unreadable database is never silently replaced.

**Limits:** 100 000 characters per prompt, 50 versions (or 256 KB of version bodies) per record,
32 tags. Similarity compares the first 4 000 normalized characters.

SQLite safely serializes writers from multiple tabs or processes. Independent edits to different
records do not overwrite one another; simultaneous edits to the same record remain last-writer-wins
unless the caller supplies the existing `updated` concurrency token.

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

On start you should see `[prompt-librarian] registered 34 routes under /prompt_librarian`. Route
registration is isolated from the old node's, so a failure in one can't take down the other.

---

## Layout

One folder per domain — `<root>/<domain>` — and the two domains import nothing from each other
(enforced by the `Domains are independent` import-linter contract):

```
__init__.py                   node mappings, WEB_DIRECTORY, both route blocks

prompt_librarian/             the Librarian domain (vertical slices, see AGENTS.md)
  __init__.py                 exports PromptLibrarian
  node.py                     adapter: the node class -> features, via app.current()
  api/                        adapter: 35 routes under /prompt_librarian
    config.py                 prefix, capabilities, exception -> status table
    utils.py                  route table, guard, JSON envelope, coercion
    routes/                   one handler module per feature group
    schemas/                  what each endpoint takes and returns, one module per group
    registration.py           register(): the route table -> aiohttp
    openapi.py                routes + schemas -> an OpenAPI 3.1 document (pydantic)
  app.py                      composition root: opens the library, wires features together
  features/                   prompts, search, dupes, autocomplete, library, storage, wildcards
  shared/                     database, library/write/Change, records, entries, meta, text, labels

prompt_store/                 the OLD node's domain — untouched
  __init__.py                 exports PromptLibrary and the prompts.json helpers
  node.py                     the node class and its store

web/prompt_librarian/         the Librarian's frontend — one directory per feature
  index.js                    extension entry (the only file with import-time side effects)
  shared/                     h(), text/number formatting, timing, the singleton bag
  api/                        request primitive, lanes, caps, routes, meta cache
  node/                       the node's face, widgets, preparation, the node ⇄ panel binding
  modal/                      overlay shell, state store, key isolation, layers, target
  browse/                     the left rail: search, filters, virtualised list
  inspector/                  the right pane: fields, dupe panel, THE SAVE FLOW
  pickers/                    the popover primitive and its five consumers
  compare/                    diff, compare/merge and version-history dialogs
  librarian.css               scoped dark theme
web/prompt_store/             the OLD node's frontend — same split, four files
scripts/openapi.py            route table -> route listing or OpenAPI spec
tests/*.py                    Python persistence/API/search tests
```

Inside `prompt_librarian/` the layers are `node : api` (independent adapters), then `app`, then
`features` (which never import each other), then `shared` — the `Librarian layers` and `Features
never import each other` contracts in `pyproject.toml`. Imports are relative, because ComfyUI loads
the pack by file path under a directory name that is not an identifier. `AGENTS.md` holds the full
rules and the migration log.

### Python — package

**`__init__.py`** (107 lines) — the only file both nodes touch. Exports
`NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS` for `PromptLibrarian` and `PromptLibrarian`, and
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

Read `AGENTS.md` for the architecture and its rules; this is the tour.

**`shared/`** — what every feature stands on. `db/` gives each thread one reused SQLite connection
with read and write transactions. `library.py` is the open library: `Library.write(op)` is one
transaction that bumps the revision, runs the derived-table writers features registered with
`extend()`, and emits exactly one `Change` after it commits. There is no in-memory copy of the
library: reads go to SQLite and caches key on the revision, so writes from another process are
seen too. `records.py` is the record shape and its rules, `entries.py` the record rows,
`meta.py` the stored settings/snippets/ignored pairs, `corpus.py` the search/dupe projection,
`labels/` the corpus-derived names.

**`features/`** — one directory per feature, one file per use-case, plain functions taking the
`Library`: `prompts/` (create, update with `expect_updated` checked inside the transaction, versions,
usage, merges, bulk), `search/` and `dupes/` (explicit `LibrarySearchSource` / `LibraryDupeSource`,
plus `upkeep` subscribers that carry, patch or drop cached scans from each `Change`),
`autocomplete/`, `library/` (settings, snippets, keep-both pairs, taxonomy), `storage/` (portable
envelope, import/export, legacy migration, health, VACUUM) and `wildcards/` (configured with a
files root and a snippet source, never importing the library).

**`app.py`** — the composition root. `build()` opens a library and wires the autocomplete
vocabulary, muted-pair cleanup, cache upkeep and the websocket broadcast; `current()` builds the
default one lazily (ComfyUI sets its user directory after import); `use()` installs another, which is
how tests and `scripts/dev.py` point every route and the node at a scratch library.

**`prompt_librarian/api/`** — the 34 aiohttp routes under `/prompt_librarian`: `config.py` owns the
prefix/capabilities/error map, `utils.py` owns routing mechanics, `routes/` groups handlers by
feature, and `registration.py` registers the completed table. `aiohttp` is imported on first use,
never at module scope, so tests and
`scripts/openapi.py` can import the package without it. Every read is GET, every write is POST (no
PATCH/DELETE, no path params — that survives ComfyUI's `/api` prefix rewriting). `_route` collects
handlers into `_ROUTES`; `_guard` wraps each one so a backend bug returns `500 {"error", "code"}`
instead of taking down the server; `_ERROR_MAP` turns store exceptions into stable codes the
frontend branches on; every response merges in `{"rev": <the library revision>}`. Anything that serializes JSON
or scans every record goes through `_offload` to a thread; dict/index lookups run inline. Routes:
GET `ping`, `search`, `prompt`, `versions`, `version`, `taxonomy`, `dupes/all`, `wildcards`,
`snippets`, `export`, `export/file`, `storage`; POST `meta`, `dupes`, `compare`, `resolve`, `create`, `update`, `rate`,
`delete`, `usage`, `bulk/{delete,retag,merge}`, `merge`, `merge_new`, `versions/restore`,
`dupes/ignore`, `snippet`, `settings`, `import`, `import/file`, `storage/{migrate,compact}`. Also exposes a `CAPABILITIES` dict the
frontend feature-detects against.

**`prompt_librarian/api/schemas/`** + **`openapi.py`** + **`scripts/openapi.py`**
— the route table, described. Every `@_route` names an OpenAPI operation id, a one-line summary and
three dataclasses: what the query takes, what the body takes, what comes back.

```python
@_route("get", "/versions", op="listVersions",
        summary="Version history of one record as previews, never full bodies.",
        query=schemas.ListVersionsQuery, returns=schemas.VersionsResponse)
```

`schemas/` is plain stdlib — dataclasses, `Literal`, `X | None` — and imports nothing, so the pack
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
of them — `schemas/` is a parallel declaration, and keeping it true to the handlers is a review
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
`Open Librarian`, and drives the three `setupGraphNode` triggers. `modal/` is imported lazily inside a
try/catch: a missing panel logs once and the node still works.

**`node/`** (4 files, 962 lines) — everything attached to the node itself. `widgets.js` owns the two
widget names and hides `prompt_id` (it must stay serialized — that string is the only link between a
workflow and a library record — but has no business taking a row on the canvas). `face.js` builds the
face in two tiers: a `.pl-node-card` DOM widget when `addDOMWidget` exists **and** the element is
verified to have mounted one frame later, falling back to plain button widgets otherwise; `open` is
passed in rather than imported, which is what keeps the entry out of the import graph. `setup.js`
sets the node up in the graph once its widgets exist. `text-sync.js` reads, writes and watches the text widget, and is the only module that
touches a LiteGraph widget's internals: `writeNodeText` is the single write path (value first, then
callback, and it also sets the backing `<textarea>` and dispatches a synthetic `input`, because
assigning `.value` from JS fires no event and the on-canvas widget would keep painting stale text),
and `watchNodeText` observes in three independent, individually optional layers — an `input`/`change`
listener on that element, a chained `Object.defineProperty` over `widget.value`, and `pollNodeText()` driven
by the modal's existing 1 s heartbeat — because which of them exists depends on a frontend generation
we cannot detect. The interception **chains onto the original descriptor** rather than replacing it:
on the legacy frontend `value` is already an accessor over `inputEl`, and a plain data property on top
silently disconnects the widget from its own element. Echoes are killed in one place for all three
layers by `lastSeen`, the last value written or observed. `watchNodeText` reference-counts its subscribers,
so the node card and the panel can both observe one node, and `unwatch` restores exactly the descriptor
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

**`modal/`** — the retained panel shell and its use cases. `index.js` is the thin
public entry, including `openModal({ targetNodeId })`. `state.js` keeps the existing singleton
and the `getState` / `setState` / `subscribe` store: equal references still notify, and silent
patches remain silent. `context.js` documents the stable, extensible object handed to panes.

| Area | Modules and responsibilities |
| --- | --- |
| `lifecycle/` | `open.js` shares initialization across concurrent opens and immediately retargets the mounted editor. `close.js` saves and cleans up per-open resources. `panes.js` independently imports and mounts Browse and Inspector, with placeholders and retry on failure. |
| `shell/` | `layout.js` builds the retained DOM and wires handlers once; `header.js` renders counts; `navigation.js` switches Browse/Edit; `responsive.js` installs per-open resize handling; `dismissal.js` owns close controls; `glyphs.js` holds labels' symbols. |
| `input/` | `keys.js` isolates ComfyUI events and supplies the key bus; `focus.js` traps focus; `shortcuts.js` handles Escape, save and Tab. |
| `overlays/` | `layers.js` owns scrims, stacking and focus restoration; `dialogs.js` supplies confirmations; `toasts.js` manages notifications and their cleanup. |
| `target/` | `host.js` accesses ComfyUI; `nodes.js` resolves targets by ID and publishes snapshots; `binding.js` mirrors node/editor changes; `load.js` explicitly loads records and counts real usage; `controls.js` renders target/link controls; `preferences.js` preserves `pl:link`. |
| `library/` | `data.js` refreshes taxonomy and lists; `drafts.js` preserves JSON buffers under `pl:draft:<id>`. |
| `storage/` | `actions.js` handles status, legacy migration, JSON import/export and shared compaction; `view.js` renders snapshots and invokes callbacks; `controls.js` connects the shell controls through subscriptions. |

Each opening has a session identity. Closing invalidates it, aborts requests, removes keyboard
and resize listeners, stops the node heartbeat and toast timers, and closes layers. Pending
opening continuations check that identity before starting more requests, mounting panes,
rebinding nodes or moving focus. The DOM, mounted panes, context and retained handlers survive
closing. A reopen can reuse pending optional-module imports without allowing the old session
to mount them. Target identity is re-resolved on the 1 s heartbeat to handle graph deletion or
replacement; linking seeds node → editor because the node holds what the workflow renders.

`lifecycle/close.js` reaches the inspector through `ctx.isDirty()` and `ctx.requestSave(true)`.
The save hook resolves to `saved | clean | blocked | failed | busy`; only `saved` and `clean`
permit closing after a save attempt. These are plain strings so the modal does not need a
static import of the optional Inspector. The existing missing-hook draft fallback is retained.

`modal/input/keys.js` is the file to read before touching anything key-related. It installs the **key isolation**
guard — a window-capture listener that calls `stopImmediatePropagation()` on every key event
originating inside `.pl-root`, so ComfyUI's global shortcuts (Delete removes the node, Ctrl+Z undoes
the graph, Space pans the canvas) can't fire while you type — and re-delivers those events on its own
key bus. That is why a plain `addEventListener("keydown", …)` is dead code everywhere else in the
panel. The guard does not prevent text-entry defaults. Ctrl/Cmd+S is the narrow exception: when its
target is inside `.pl-root`, the real event is consumed to save the prompt and suppress *Save Page*.
On close, the retained card also drops `aria-modal`; ComfyUI uses the visibility-blind selector
`[role="dialog"][aria-modal="true"]` as a global-command gate, so `state.js` changes that marker and
the retained root's visibility together. Leaving the attribute on a hidden card would disable
workflow save after the Librarian's first use.

**`browse/`** (8 files) — the left rail: search box with live hit count, filter chips,
`dupes only`, sort tabs, the virtualised list. `paged-source.js` handles
200-record pages and the skeleton rows for holes, `grouped-source.js` the duplicate accordion —
`virtual-list.js` places every row at `i * --pl-row-h`, so an opened cluster is *one row plus N
ordinary rows*, never one taller row, and this file is the flat-index mapping that makes that true
while clusters open and close (it also self-heals a remembered index whose record moved out from
under it). `virtual-list.js` is the recycled window (and
`compare/versions.js` reuses it for long histories), `rows.js` the row markup and its textContent-only
paint, `selection.js` the two modes — explicit ids, or the abstract "all filtered", which stores the
QUERY rather than 1 284 ids because that is the only shape that scales and exactly what the bulk
endpoints accept — `chips.js`, `picker.js` and `index.js` (`mountList`). All search is
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
`wildcards/syntax.py` — a highlight that disagrees with the resolver is worse than no highlight) and
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
| `test_store.py` | 35 | SQLite-backed CRUD, validation, conflicts, bulk ops, version trimming, merge semantics, taxonomy, snippets, ignored pairs and portable JSON envelopes. |
| `test_store_sqlite.py` | 15 | SQLite durability, indexed search projections, independent writers, database health/optimization, and explicit JSON/JSONL migration. |
| `test_search.py` | 44 | Free-standing (plain dict fixtures, no store): tokenizing, index building, query operators, scoring, filters, all four sorts, paging. |
| `test_labels.py` | 29 | Also free-standing: distinctive-term selection, stopwords and the digit exception, phrase merging, ordering, caps, the body-head fallback, the smoothed idf that keeps a one-record library labelled, and that `term_tokens` folds exactly as `search.normalize` does. |
| `test_dedupe.py` | 39 | Also free-standing: ratio cascade vs raw `difflib`, length prefilter, blocking index correctness, clustering, cache invalidation, diff opcodes and summaries. |
| `test_wildcards.py` | 63 | Determinism, nesting, weights, pick-N, escapes — and the three guards that matter for not hanging a render worker: path traversal, cycles, output size. |
| `test_api.py` | 70 | Drives handlers directly with a stub request (`.rel_url.query` + async `.json()`), so no server is stood up; skips wholesale if aiohttp is absent. Route table, error-code mapping, `rev` propagation. |
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
| `structure.test.js` | 9 | Tier 0, no jsdom. Every module imports through the mirror; the four `../` depths land on the stubs; only the declared files touch ComfyUI and the two domains stay independent; **`INERT ON IMPORT` as a runtime assertion** — imported with no `document`/`window` at all, the singleton bag must hold exactly `lanes` and `caps`; `api.fetchApi` is the only network call site. |
| `devharness.test.js` | 8 | The dev playground's own source, which nothing else would notice a typo in until the page was opened. |
| `unit/records.test.js` | 32 | `inspector/records.js` — zero imports, and `sig()` is the dirty comparison the whole close flow rests on. |
| `unit/text-format.test.js` | 44 | Grapheme safety (both the `Intl.Segmenter` and `Array.from` branches), label derivation, `relTime` with `now` injected, `escapeQuery` round-tripping. |
| `unit/tokenize-timing.test.js` | 22 | The wildcard grammar against its Python counterpart, including the two deliberate divergences; `debounce`/`rafThrottle` including `cancel()`, which `closeModal()` relies on. |
| `dom/modal-lifecycle.test.js` | 19 | Concurrent opening and retargeting; close during ping, taxonomy, imports and refresh; retained panes and context on reopen; independent pane failures; node deletion/replacement and link toggling; responsive tabs; listener, observer, heartbeat and toast cleanup. |
| `dom/modal-contracts.test.js` | 3 | Public exports, singleton/context identity, subscription semantics, draft JSON and `pl:link` preferences. |
| `dom/storage.test.js` | 13 | Synthetic storage responses, legacy confirmation/cancellation, shared compaction, import choices, export cleanup, capability changes and late status responses. |
| `dom/close-save.test.js` | 19 | **Save-on-close.** The five-status matrix (`saved`/`clean` close; `blocked`/`failed`/`busy` stay open), the `it.closing` re-entry latch against Esc-mashing, the close button disabled for the round trip, all three close routes, the drag-to-backdrop that must *not* close, full teardown, and modal semantics restored on reopen. |
| `dom/dupe-gate.test.js` | 10 | **Getting back out of the duplicate gate**, `createSave()` driven with a hand-built pane: the gate blocks and writes nothing, `save anyway` is the *last* dialog (one click, no second confirm) and mutes every pair it listed, an update stays an update rather than forking, a failed mute still leaves the record saved and complains once, and `keep both` mutes only its own row. Plus the split that keeps a mute honest: an already-muted match does not gate the save, but its score is untouched, so every counting surface still sees it. |
| `dom/dupe-accordion.test.js` | 17 | **The duplicate accordion**, both tiers. `updateRow`'s three row kinds (cluster header badged `N copies`, quiet indented member, ordinary row keeping its near-dupe badge — and a view-less call painting flat, which is how `compare/` reuses the renderer); then the real rail against a stubbed `/search`: four copies are one row, the twisty opens and closes it in place, clicking a header opens *and* selects, ticking a collapsed cluster ticks all four, and "all filtered" counts records rather than rows. |
| `dom/dupe-panel-muted.test.js` | 9 | **A muted pair is shown, not swallowed.** The live panel lists it marked, counts it in the heading (`3 near matches (2 muted)`), drops the amber when nothing is left to warn about, and un-mutes it back into the gate — including the failure path, and the unsaved draft that has no pair to un-mute in the first place. |
| `unit/grouped-source.test.js` | 20 | `browse/grouped-source.js` against a fake `PagedSource`: rows vs records, the index shift an open cluster imposes on everything below it, what a row *stands for* when ticked (a collapsed cluster is its whole cluster), ranges loaded in top-level indices, and a stale span self-healing rather than shifting the list by two forever. |
| `dom/shortcuts.test.js` | 12 | Ctrl/Cmd+S follows the active surface against a faithful ComfyUI `window` handler: the Librarian owns the chord while open, closing clears ComfyUI's DOM modal gate, workflow save resumes afterward, prompt save fires once, `e.repeat` is guarded, layers take precedence, and plain typing is never prevented. |
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

### The dev tool — `scripts/dev.py`

```
python scripts/dev.py            # play: 50 curated prompts, a fake node, the modal open
python scripts/dev.py sim        # replay every scenario and compare to the baseline
python scripts/dev.py baseline   # replay every scenario and accept the result
```

No flags. Set `PL_DEV_PORT` to move off 8189. Run it with **the Python you start ComfyUI with**: it
needs `aiohttp`, which ComfyUI provides and which is deliberately not a runtime dependency of this
pack. The script says so up front if the interpreter lacks it.

**Play** serves the real routes against a scratch library in `.devserver/play/`, the real `web/`
tree at ComfyUI's URL layout (API under `/api` only, as behind a proxy), and stub
`/scripts/{app,api}.js` from `devharness/`. Every run starts from the same seeded library, copied
from a cache in `.devserver/seed/` that is rebuilt only when the pack's Python or the seed data
changes. The page creates a node and opens the librarian by clicking its own button. Edit `web/`
and the page reloads; a `.py` change re-execs the server and keeps the library you were playing with.
`reset data` on the page restores the seed.

`devharness/` is checked in rather than generated, because the fake node is not boilerplate: it is
where the widget shapes `node/text-sync.js` defends against are written down, and the page can switch
between them (`legacy` / `domwidget` / `opaque`), make `addDOMWidget` absent, throw, or accept and
never mount, delay the widgets, and pick which graph probe `modal/target/nodes.js` will find.

**Sim** replays the flows in `scripts/devkit/scenarios.py` (saving, editing, loading into the node,
node runs, rating then saving, a writer holding the lock, duplicate scans, a 300-prompt library)
through the real HTTP routes, each on a fresh library in the OS temp directory. Scenarios see only
the HTTP API, the node's `run()` and the library path, so they run unchanged across backend
refactors. Ids and timestamps are pinned to call order, which makes outcomes and SQLite connection
counts deterministic; both are compared with `scripts/devkit/baseline.json`. A changed outcome or a
higher connection count fails; a step more than 2x slower only warns, because timings depend on the
machine. `tests/test_dev.py` runs the sim.

**It cannot touch a real library.** Four independent layers have to fail first: the explicit
`app.build(path=…)` override, a stub `folder_paths` injected before the pack imports, a pinned
`_FALLBACK_USER_DIR`, and a guard that refuses anything shaped like a real library, anything outside
the scratch root, and wiping any directory the tool did not create. The scratch app is then installed with `app.use()`, the one
place routes and the node get their library from.

### The old node — untouched

**`prompt_store/node.py`** (146 lines) — the original `PromptLibrarian` node and its
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
npm test                         # 158 JS tests, no ComfyUI and no browser
ruff check .                     # style, imports, complexity
lint-imports                     # the layer + independence contracts
python3 scripts/openapi.py       # the route table, as a listing or a spec

python3 scripts/dev.py                   # the whole UI, with 50 prompts, at localhost:8189
python3 scripts/dev.py sim               # scenarios against the committed baseline
```

On Windows the interpreter is `python` (or `py`), not `python3` — and for `dev.py` it must be
the one ComfyUI runs on, see below.

Both suites run in about a second and neither needs ComfyUI. `npm test` skips nothing; the pytest
route-contract test skips with a reason if `node` is not installed.

`tests/conftest.py` stubs `folder_paths` at a temp directory, so the suite never touches a real user
directory. `lint-imports` reads its contracts from `pyproject.toml` and analyses the two domain
packages, which is why they are packages rather than loose modules — the pack root's directory name
is not a valid Python identifier and cannot be imported outside ComfyUI.
