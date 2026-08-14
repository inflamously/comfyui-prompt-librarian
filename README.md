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
or show a name. That is also why there are no combo widgets: it sidesteps the entire class of
LiteGraph/Vue combo-reactivity problems the older node has to work around.

### The node and the panel are one field

The panel's prompt box and the node's `text` widget are **two views of the same value**.
Type in either and the other follows; the node's card preview follows too. Picking a prompt in
the rail loads it straight into the node — body *and* `prompt_id`, which is what keeps usage
counting honest.

The header carries a **⇅ linked** chip. Turn it off to browse, edit and save library records
without touching the node at all; `Load into node` still pushes on demand. The setting is
remembered across reloads.

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

- **Left rail** — fuzzy search over name + body + tags with a live hit count, category/tag filter
  chips, a `dupes only` toggle, `relevance | recent | most used | a–z` sorting, and a virtualised
  list. Each row shows its near-dupe count and, when you have a prompt selected, its `% match`
  against it — so duplicates are visible *before* you open anything.
- **Right pane** — name, category, tags, the prompt text with char and token counts, the duplicate
  check panel, four stat tiles (used / last run / versions / rating), and the action bar.

Search supports operators: `tag:dance`, `cat:videogen`, `-word` to exclude, and `"quoted phrase"`.

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

- **Version history** — every save that changes the body or name snapshots the previous one. Browse,
  diff against current, restore (restore is itself undoable), or push an old version to the node
  without saving.
- **Compare / merge** — word-level diff, side by side. Merging sums usage counts, unions tags, keeps
  the higher rating, and preserves the loser's body as a version.
- **Bulk operations** — checkboxes with shift-click ranges and `select all filtered`, then bulk
  delete, retag, recategorize, or merge duplicate clusters. Destructive actions confirm with counts.

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
  "categories": ["videogen_edit_minimax"],
  "snippets": { "cine_lighting": { "body": "volumetric haze, 35mm", "updated": "..." } },
  "ignored": [["idA", "idB"]],
  "prompts": [{
    "id": "9f2c1b7e4a5d4f0e8c3b1a2d5e6f7a8b",
    "name": "ballet_drift_v3",
    "body": "make him dance ballet slowly drifting towards the camera, ...",
    "category": "videogen_edit_minimax",
    "tags": ["dance", "camera-move"],
    "rating": 4, "used": 41,
    "last_run": "2026-08-11T19:03:22Z",
    "created": "...", "updated": "...",
    "notes": "", "pinned": false,
    "versions": [{ "body": "...", "name": "ballet_drift_v2", "ts": "...", "src": null }]
  }]
}
```

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
  api.py                      31 routes under /prompt_librarian
  wildcards.py                {a|b} / __file__ / [[snippet]] resolution
  dedupe.py                   similarity cascade, dupe caches, word-level diff
  search.py                   inverted index, relevance scoring, filters, sorts
  store.py                    schema, atomic I/O, CRUD, versions, merge, snippets

prompt_store/                 the OLD node's domain — untouched
  __init__.py                 exports PromptLibrary and the prompts.json helpers
  node.py                     the node class and its store

web/pl_librarian.js           extension entry (the only file with import-time side effects)
web/pl/*.js                   api, bind, dom, modal, list, inspector, dialogs, pickers
web/pl/librarian.css          scoped dark theme
web/prompt_library.js         the OLD node's frontend — untouched
tests/*.py                    290 tests, stdlib + pytest only
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
`store_path`, `backup_path`, `wildcards_dir`), field cleaners (`clean_name`, `clean_tags`,
`clean_body`, `clean_category`) and the `_coerce` layer that makes a hand-edited file loadable.
The bulk is `class LibrarianStore`: lock-guarded load/save (temp file + `os.replace` with retries
for transient Windows locks, `.bak.json` rewritten each save, corrupt files moved aside rather than
overwritten, newer-schema files loaded read-only), a monotonic `rev()` used for cache invalidation,
`on_change` callbacks plus websocket `_notify`, then CRUD (`create`, `update`, `set_rating`,
`delete`, `record_usage`), bulk ops (`bulk_delete`, `bulk_retag`, `bulk_categorize`, `bulk_merge`),
versions (`versions`, `version_previews`, `restore_version`, `_trim_versions`), `merge` /
`merge_new`, taxonomy (`categories`, `tags`, `add/rename/delete_category`), snippets, the ignored-
pair list (`ignore_pair` / `is_ignored`), and `export_raw` / `import_raw`. Ends with the module-level
singleton `STORE`.

**`prompt_librarian/search.py`** (888 lines) — stdlib-only, knows nothing about aiohttp, ComfyUI or the
file format; it takes an iterable of record dicts or anything with `list_all()` + `rev()`. Holds the
scoring weights as module constants so they stay patchable from tests (`W_NAME 3.0`, `W_TAG 2.0`,
`W_CAT 1.5`, `W_BODY 1.0`, phrase bonuses, popularity/recency nudges, and the exact/prefix/infix
tiers). Provides `normalize`, `tokenize`, `preview`, the `Doc` and `SearchIndex` dataclasses,
`build_index` / `get_index` / `invalidate_index`, the query parser (`ParsedQuery`, `parse_query`,
handling `tag:`, `cat:`, `-exclude` and `"quoted phrases"`), `score_doc`, the filter and sort passes
(`relevance | recent | most_used | az`), and the public `search()` returning a page dict.
Timestamps are compared as plain ISO strings — nothing here parses a date.

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

**`prompt_librarian/api.py`** (849 lines) — the 31 aiohttp routes under `/prompt_librarian`. `aiohttp` is
imported inside `register()`, never at module scope, so tests can import the module without it.
Every read is GET, every write is POST (no PATCH/DELETE, no path params — that survives ComfyUI's
`/api` prefix rewriting). `_route` collects handlers into `_ROUTES`; `_guard` wraps each one so a
backend bug returns `500 {"error", "code"}` instead of taking down the server; `_ERROR_MAP` turns
store exceptions into stable codes the frontend branches on; every response merges in
`{"rev": STORE.rev()}`. Anything that serializes JSON or scans every record goes through `_offload`
to a thread; dict/index lookups run inline. Routes: GET `ping`, `search`, `prompt`, `versions`,
`version`, `taxonomy`, `dupes/all`, `wildcards`, `snippets`, `export`; POST `meta`, `dupes`,
`compare`, `resolve`, `create`, `update`, `rate`, `delete`, `usage`, `bulk/{delete,retag,categorize,
merge}`, `merge`, `merge_new`, `versions/restore`, `dupes/ignore`, `category`, `snippet`,
`settings`, `import`. Also exposes a `CAPABILITIES` dict the frontend feature-detects against.

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

**`web/pl_librarian.js`** (445 lines) — the extension entry, and the only file in the pack allowed
import-time side effects: one `app.registerExtension({name: "prompt-librarian.ui"})`, one stylesheet
injection, one `nodeCreated` hook. Hides the `prompt_id` widget, builds the node face — a DOM card
via `addDOMWidget` (`buildDomFace` / `buildNodeCard`, with name, preview, star row and usage count),
falling back to plain button widgets (`buildButtonFace`) when the installed frontend doesn't mount
it — hydrates metadata from the backend (`ensureHydrated`, `refreshMeta`), paints it (`paintFace`,
`paintStars`), supports rating straight from the node, and opens the panel via `openLibrarian`.
`bindFace` subscribes the card to bind.js so the preview line tracks edits made in the node's own
text widget; it is independent of the panel and unsubscribes from a chained `onRemoved`.

**`web/pl/api.js`** (627 lines) — the transport layer, and the only module under `web/pl/` that
imports from ComfyUI. Uses `api.fetchApi` rather than bare `fetch` so the base URL / reverse-proxy
prefix is applied. Exports `BASE`, the `ABORTED` sentinel (a superseded call is not an error, so no
call site needs an AbortError try/catch), `ApiError`, `createLane` / `lanes` / `cancelAllLanes` for
per-concern request coalescing, `caps` / `capable` for feature detection against the backend's
`CAPABILITIES`, the `API` object with one method per route, and the metadata cache
(`getPromptMeta`, `invalidateMeta`).

**`web/pl/bind.js`** — the node ⇄ panel binding, and the only module that touches a LiteGraph
widget's internals. `writeNodeText(node, {body, id})` is the single write path (used by both the live
binding and `Load into node`): value first then callback, and it also sets the widget's backing
`<textarea>` and dispatches a synthetic `input`, because assigning `.value` from JS fires no event and
the on-canvas widget would otherwise keep painting stale text. `bindNode(node, onChange)` observes in
three independent, individually optional layers — an `input`/`change` listener on that element, a
chained `Object.defineProperty` over `widget.value`, and `poll()` driven by modal.js's existing 1 s
heartbeat — because which of them exists depends on a frontend generation we cannot detect. The
interception **chains onto the original descriptor** rather than replacing it: on the legacy frontend
`value` is already an accessor over `inputEl`, and a plain data property on top silently disconnects
the widget from its own element. Echoes are killed in one place for all three layers by `lastSeen`,
the last value written or observed. `bindNode` reference-counts its subscribers, so the node card and
the panel can both observe one node, and `unbind` restores exactly the descriptor it found.

**`web/pl/dom.js`** (629 lines) — dependency-free DOM and formatting helpers, no ComfyUI import.
`h()` hyperscript (with a `DIRECT_PROPS` set for props that must be assigned rather than
`setAttribute`d), `append` / `clear` / `cls`, `ensureStyles` (idempotent stylesheet link),
`debounce` and `rafThrottle`, `setComboValues` (a combo-list updater duplicated in behaviour from
the old node's file rather than imported from it, so the two packs stay independently deletable),
grapheme-aware `charCount` / `truncate` / `firstLine`, `estimateTokens`, `stars`, `relTime`, `fmtInt`,
`escapeQuery`, the `singleton` / `singletonBag` registry that survives a module re-import, and
`warnOnce`.

**`web/pl/modal.js`** (1459 lines) — the overlay shell and the app's spine. Owns the header / rail /
inspector / footer DOM, the state store (`getState`, `setState`, `subscribe`), the layer stack
(`pushLayer`, `popLayer`, `topLayer`), `toast()` and `confirmDialog()`, target-node resolution
(`getTargetNodeId`, `loadIntoNode`), `refreshAll`, the shared `ctx()` handed to every submodule, and
`openModal` / `closeModal`. It also owns the **node binding**: the `⇅ linked` toggle and its
`localStorage` preference, `attachBinding` / `detachBinding` / `syncBinding` (reconciled on the same
1 s heartbeat that re-resolves the target, so a re-pointed or re-created node is picked up without a
hook of its own), and the `pushToNode` / `isLinked` / `setLinked` trio on `ctx`. The seed direction on
attach is node → panel, deliberately: the node holds what will actually render. It also installs the **key isolation** guard — a window-capture listener
that calls `stopImmediatePropagation()` on every key event originating inside `.pl-root` so ComfyUI's
global shortcuts can't fire while you type — and re-delivers those events on its own key bus, which
is why plain `addEventListener("keydown", …)` is dead code anywhere else in the panel. `list.js` and
`inspector.js` are imported lazily inside try/catch, so a broken module degrades to a placeholder
rather than an empty modal.

**`web/pl/list.js`** (1122 lines) — the left rail: search box with live hit count, filter chips,
`dupes only`, sort tabs, the virtualised list, and the footer/bulk bar. `PagedSource` handles paging
and skeleton rows, `VirtualList` the recycled window, `mountList(el, ctx)` wires it up, and
`ROW_CLASSES` is the frozen class map. All search is server-authoritative — there is no local
filtering here by design, because the `% match` and near-dupe badges are computed by the backend for
the current page and a locally-filtered list would show rows whose badges disagree with it.

**`web/pl/inspector.js`** (1861 lines) — the right pane: name, category, tags, the prompt textarea
with char/token counts and the `edited` marker, the duplicate-check panel, the four stat tiles and
the action row. Single export, `mountInspector(el, ctx)`. Its half of the node binding is three
hooks and no restructuring: `afterEdit()` pushes the buffer through an rAF-coalesced `pushBody` (so a
fast typist costs one canvas repaint per frame, not per keystroke), `setBody(text, {fromNode})` marks
the inbound direction and yields to whichever textarea holds the caret, and `adoptRecord(rec, {push})`
writes body **and** `prompt_id` — opt-in, and set only on a user selection or a save, never on
deselect, a background refresh, or the initial paint. The echo guard is `lastInbound`, a value rather
than a flag, because the push is coalesced to the next frame and any "currently applying" marker would
already be clear by the time it runs. Its reason for existing is the save flow:
not-dirty check → staleness check → dupe gate (always re-run on save) → commit (`create`, or
`update` with `expect_updated`, with a 409 re-entering the staleness step) → adopt the server's
record as both `current` and `baseline`. The staleness and dupe dialogs are built inline via
`ctx.pushLayer` rather than through `dialogs.js`, so the safety property still holds on an install
where `dialogs.js` failed to load. Never `innerHTML` — prompt bodies are user data.

**`web/pl/dialogs.js`** (1910 lines) — the three big overlays: `renderDiff()` (the split/unified diff
primitive shared by all of them, capped at `MAX_TOKENS_PER_SIDE = 5000`), `openCompare()` (compare /
merge, used for dupes, diff-vs-saved and versions), `openMergeEditor()` (the editable "merge → new"
union) and `openVersions()` (two-pane version history with restore). Every key handler goes through
a `bindKey()` helper on modal.js's key bus, per the isolation rule above.

**`web/pl/pickers.js`** (1783 lines) — one popover primitive, `openPopover()`, serving five
consumers: `openCategoryPicker`, `openTagPicker` (with `normalizeTag`), `openThresholdPicker`,
`openSnippets` and `openWildcards`. Plus `insertAtCaret()`, `tokenizeWildcards()` (the wildcard
syntax lexer) and `attachMirror()` — the highlight layer rendered behind the textarea, which only
lines up if every typographic property matches exactly.

**`web/pl/librarian.css`** (1836 lines) — the scoped dark theme. Tokens on `.pl-root`, then sections
for the overlay, header, rail, filter chips, virtual list (including the skeleton rows), inspector,
mirror/highlighting, stat tiles, action bar, dialogs, diff panes, toasts and popovers. Everything is
scoped under `.pl-root` / `.pl-node-card` with `pl-`-prefixed class and keyframe names, and includes
an inbound-defence block restating inherited properties so a stray ComfyUI rule can't reach in.

### Tests

`tests/` runs on pytest with no ComfyUI and no third-party imports.

| File | Tests | Covers |
|---|---|---|
| `conftest.py` | — | Injects a stub `folder_paths` into `sys.modules` **before** `prompt_librarian.store` imports, and an autouse fixture repoints it at each test's `tmp_path`. Also puts the pack root on `sys.path` so the `from prompt_librarian import search` form works. No test can reach a real user directory or the old node's `prompts.json`. |
| `test_store.py` | 47 | Schema coercion, atomic write and backup, corrupt/newer-schema handling, CRUD, conflicts, bulk ops, version trimming, merge semantics, taxonomy, snippets, ignored pairs. |
| `test_search.py` | 44 | Free-standing (plain dict fixtures, no store): tokenizing, index building, query operators, scoring, filters, all four sorts, paging. |
| `test_dedupe.py` | 39 | Also free-standing: ratio cascade vs raw `difflib`, length prefilter, blocking index correctness, clustering, cache invalidation, diff opcodes and summaries. |
| `test_wildcards.py` | 63 | Determinism, nesting, weights, pick-N, escapes — and the three guards that matter for not hanging a render worker: path traversal, cycles, output size. |
| `test_api.py` | 67 | Drives handlers directly with a stub request (`.rel_url.query` + async `.json()`), so no server is stood up; skips wholesale if aiohttp is absent. Route table, error-code mapping, `rev` propagation. |
| `test_node.py` | 30 | The load-bearing node properties: `INPUT_TYPES` is pure (no disk, no combos), `run()` never fails a render, `IS_CHANGED` responds to the right inputs, and usage counts only a run of the *saved* body. |

### The old node — untouched

**`prompt_store/node.py`** (146 lines) — the original `PromptLibrary` node and its
`{category: [text, ...]}` store at `<user>/default/prompt-library/prompts.json`. Holds
`_load_prompts` / `_save_prompts` (tolerating the older flat `{name: text}` format), `_category_names`
(which returns `["<empty>"]` because an empty combo list breaks the frontend), `_save_target`,
`_add_prompt`, and the node class with its `VALIDATE_INPUTS` returning `True` unconditionally to
bypass server-side validation of a JS-populated combo.

**`web/prompt_library.js`** (191 lines) — its frontend. Registers `prompt-library.ui`, builds combo
labels by stripping the common token prefix/suffix across a category's prompts, and works around the
combo-reactivity problems described above. Nothing in the Librarian imports from it.

Every module under `web/pl/` is inert on import, because ComfyUI loads every `.js` under the web
directory as an extension. All CSS is scoped under `.pl-root` / `.pl-node-card` with `pl-` prefixed
class and keyframe names, so nothing leaks into ComfyUI's own UI.

The node face uses `addDOMWidget` when the installed frontend has it, and falls back to plain button
widgets when it doesn't — verified by checking the element actually mounted, since some frontends
accept the call and silently drop it. `Open Librarian` exists either way.

## Tests

```
python3 -m pytest tests/ -q      # 290 tests, no ComfyUI required
ruff check .                     # style, imports, complexity
lint-imports                     # the layer + independence contracts
```

`tests/conftest.py` stubs `folder_paths` at a temp directory, so the suite never touches a real user
directory. `lint-imports` reads its contracts from `pyproject.toml` and analyses the two domain
packages, which is why they are packages rather than loose modules — the pack root's directory name
is not a valid Python identifier and cannot be imported outside ComfyUI.
