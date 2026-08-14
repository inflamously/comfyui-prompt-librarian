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

```
librarian_store.py       schema, atomic I/O, CRUD, versions, merge, snippets
librarian_search.py      inverted index, relevance scoring, filters, sorts
librarian_dedupe.py      similarity cascade, dupe caches, word-level diff
librarian_wildcards.py   {a|b} / __file__ / [[snippet]] resolution
librarian_api.py         31 routes under /prompt_librarian
prompt_librarian.py      the node class
web/pl_librarian.js      extension entry (the only file with import-time side effects)
web/pl/*.js              api, dom, modal, list, inspector, dialogs, pickers
web/pl/librarian.css     scoped dark theme

prompt_store.py          the OLD node — untouched
web/prompt_library.js    the OLD node's frontend — untouched
```

Every module under `web/pl/` is inert on import, because ComfyUI loads every `.js` under the web
directory as an extension. All CSS is scoped under `.pl-root` / `.pl-node-card` with `pl-` prefixed
class and keyframe names, so nothing leaks into ComfyUI's own UI.

The node face uses `addDOMWidget` when the installed frontend has it, and falls back to plain button
widgets when it doesn't — verified by checking the element actually mounted, since some frontends
accept the call and silently drop it. `Open Librarian` exists either way.

## Tests

```
python3 -m pytest tests/ -q      # 290 tests, no ComfyUI required
```

`tests/conftest.py` stubs `folder_paths` at a temp directory, so the suite never touches a real user
directory.
