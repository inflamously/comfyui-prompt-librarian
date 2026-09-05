# Privacy boundary

The real ComfyUI user directory is strictly forbidden. Do not read, list,
search, inspect, open, copy, summarize, modify, or delete anything under:

`/<path-to-comfyui>/user/`

This prohibition includes filenames, directory entries, file metadata, prompt
contents, workflows, settings, backups, wildcard files, and every other nested
path. Do not run commands whose scope could traverse or reveal this directory.

For development and tests, use only synthetic fixtures in temporary directories
outside the real ComfyUI user directory. Never point tests, scripts, dev servers,
or storage backends at the real user directory.

# Commands

```bash
python3 -m pytest -q            # Python suite
npm test                        # JS suite (web/), runs without ComfyUI
python3 -m ruff check prompt_librarian tests
lint-imports                    # architecture contracts in pyproject.toml
python3 scripts/dev.py          # play: fresh seeded library, fake node, modal open
python3 scripts/dev.py sim      # scenarios vs scripts/devkit/baseline.json (~15 s)
python3 scripts/dev.py baseline # accept a deliberate change in outcomes or connections
```

# Architecture (Python backend, `prompt_librarian/`)

Vertical slices: every feature is self-contained, and nothing is shared
implicitly.

```
prompt_librarian/
    app.py            composition root: build(), current() (lazy), use(); wires projectors,
                      cache upkeep, websocket broadcast and wildcards
    node.py           adapter: ComfyUI node -> features
    api/              adapter: aiohttp only; routes/<group>.py and schemas/<group>.py;
                      routes reach the library only through app.current()
    shared/           leaf library, imports nothing from features/, api/, node, app
        db/           connection (one per thread, read/write transactions), schema, state (revision)
        events.py     Change(op, ids, old_rev, new_rev, bodies_changed, records), EventBus
        library.py    Library: the open file, write(op) -> one Change, extend(setup, projector)
        records.py    record shape: clean/coerce, versions, merge arithmetic
        entries.py    the record rows (entries, tags): prompts, imports and migration write here
        meta.py       the stored envelope: settings, snippets, ignored pairs; edit() transaction
        corpus.py     search/dupe projection tables (normalized text, terms, FTS)
        text.py       normalize, preview
        labels/       corpus-derived labels (search and prompt responses both use them)
        errors.py, paths.py
    features/
        prompts/      get, create, update, delete, rate, usage, merge, bulk, versions
        search/       query, scoring, index cache; LibrarySearchSource; upkeep
        dupes/        similarity, find_similar, all-pairs scan and cache, compare;
                      LibraryDupeSource; upkeep (patches cached scans from Change)
        autocomplete/ vocabulary (tables, extraction, projector), suggest
        library/      settings, snippets, ignored pairs (+ forget_deleted projector), taxonomy
        storage/      envelope, export, importing, records (bulk writes), legacy + migrate,
                      health (+ storage_status), compact
        wildcards/    resolver, files, sources; configure(root, snippets) from the composition root
tests/                features/ and shared/ mirror the package; tests/uc.py imports every
                      use-case under one name for the older behaviour suites
```

`prompt_store/` (the older node) and `web/` are out of scope and stay as they are.
The HTTP API and the on-disk SQLite schema do not change.

## Rules

1. **One file, one use-case.** A use-case that outgrows a file becomes a directory
   under its feature, with private helpers kept inside it.
2. **Features never import each other.** Shared needs move to `shared/`; coupling
   between features lives in `app.py`, never in the features.
3. **`shared/` imports nothing above it.** Code earns its place there by having a
   second real consumer.
4. **Relative imports only.** ComfyUI loads the pack by file path under a
   directory name that is not an identifier, so `import prompt_librarian` fails at
   runtime. Boundaries are enforced by import-linter, which reads the graph.
5. **Functions by default, classes only for state** (connections, caches, the
   event bus). A use-case looks like `create_prompt(lib, body, tags)`.
6. **One write, one transaction.** Features that keep derived tables register a
   projector in `app.py`; it runs inside the writer's transaction. Read-then-write
   checks (`expect_updated`) happen inside that transaction too.
7. **No in-memory mirror of the library.** Read from SQLite; key caches on the
   database revision. Cache upkeep reacts to `Change` events, so API, node and
   bulk writes follow the same path. Routes never patch caches themselves.
8. **Style:** type annotations (ruff `ANN`), Google docstrings on public
   functions (ruff `D`), complexity ceiling 8. Enforced by
   `prompt_librarian/{shared,features}/ruff.toml` with no exempt modules; new
   top-level modules (like `app.py`) are checked against the same config. The
   five `# noqa: C901` markers in search/dupes are deliberate, each with its
   reason; do not add more without one.
9. **Routes stay thin.** Parse the request, call one use-case, shape the response.

## Contracts (in `pyproject.toml`, enforced by `lint-imports`)

- Layers, highest first: `node : api` (independent adapters), `app`, `features`,
  `shared`. So `shared` imports nothing above it and `features` never reach `app`,
  `api` or `node`.
- `features.*` are independent of each other.
- `prompt_librarian` and `prompt_store` (the old node) are independent.

# Upcoming tasks

- [ ] **Find god classes and lengthy Python files.** List the modules and classes
      that have grown too large and propose how to split them.
- [ ] **Fix the "not saved" modal popup.** After starting the dev server, an
      unsaved-changes popup appears even though nothing was edited.
- [ ] **Why use wildcards?** Work out what the wildcards feature is for and whether
      it earns its place.
- [ ] **Clean up the frontend** (`web/`).
- [ ] **Clean up the routes**, especially their structure (`api/routes/`).
