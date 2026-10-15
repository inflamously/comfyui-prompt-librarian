# Frontend restructure plan (`web/prompt_librarian/`)

Outcome of the structure interview on 2026-10-05. The rules live in `AGENTS.md`
(section "Architecture (frontend, `web/prompt_librarian/`)"); this file holds the
target tree, the old → new mapping and the migration steps.

## Decisions

| Topic | Decision |
|---|---|
| Build step | None, hard rule. ComfyUI loads raw `.js` under `web/`. |
| Framework | None. A small in-house `Component` base class and `Store`; no vendored libraries. |
| Code style | Classes for UI (DOM + lifecycle); pure functions in their own modules for logic. |
| Shape | ComfyUI → `index.js` (hook over `app`) → `modal/` ⇄ `features/*`, with `api/` and `shared/` below. |
| Wiring | `modal/app.js` is the only place features are connected (like backend `app.py`). Replaces the `ctx` bag. |
| State | One app `Store` split into slices. A feature reads and writes **its own slice only**; cross-slice data comes in through the wiring. |
| API client | Stays top-level `api/`. Features receive it as a constructor dependency. |
| Widgets | Domain-free UI widgets in `shared/ui/`. |
| CSS | A `.css` file beside each component, `shared/ui/tokens.css` for colours and spacing, injected as `<link>` once per file. |
| Naming | kebab-case files everywhere. |
| Node side | `modal/node/`, still imported eagerly by `index.js`. |
| Loading | Only `index.js` → `modal/` is lazy. Inside, plain static imports: no alias probing, no fallbacks. |
| Dropped (frontend only) | Wildcards and snippets pickers, the textarea mirror and the wildcard tokenizer. Backend untouched. |
| Tags | `features/tags/`, moved as-is; reworked after the migration. |
| Enforcement | `tests-js/structure.test.js` plus the rules in `AGENTS.md`. |
| Migration | Full plan first, then one slice per step with both test suites green. |

## Target tree

```
web/prompt_librarian/
    index.js            ComfyUI entry: registerExtension; imports modal/node/ eagerly,
                        modal/index.js lazily
    api/                request, routes, lanes, caps, meta (as today)
    shared/             leaf: imports nothing above it
        component.js    Component base class (mount, destroy, owned listeners/children)
        store.js        Store with slices
        keys.js         key bus (window capture vs ComfyUI shortcuts), from modal/input/keys.js
        styles.js       CSS <link> loader, resolved from import.meta.url
        pictures.js     word picture cache (remember/forget/pictureOf/load)
        dom.js text.js format.js timing.js singleton.js ns.js widgets.js
        ui/             domain-free widgets, each with its own .css
            tokens.css
            dialog.js layer-stack.js toast.js popover.js menu.js virtual-list.js chip.js
    features/           independent slices; never import each other
        browse/         list rail, chips, sources, rows, selection
        inspector/      editor pane, view, save, drafts, records
        dupes/          dupe panel + threshold picker
        autocomplete/   completion context/position, menu, word preview
        compare/        compare dialog, diff, merge editor, versions
        storage/        footer controls, storage dialog, actions
        tags/           tag picker, normalizeTag
        gallery/        word gallery: grid, entry, arrange, A/B compare
        word-pictures/  template, runner, progress panel, start
    modal/
        index.js        public: setHost, openModal
        app.js          composition root: passes api + slices, wires callbacks
        instance.js     the runtime bag on the singleton: shell handles, session, layers,
                        teardown, and the Store with its slices
        shell/          layout, header, navigation, responsive, dismissal
        lifecycle/      open, close (save-on-close)
        input/          focus, shortcuts (uses shared/keys.js)
        target/         binding, nodes, load, preferences, controls, host
        node/           face, setup, text-sync, widgets, word-picture-menu (eager)
        library.js      refreshAll, reportError (library slice)
        drafts.js       pl:draft:<id> helpers
```

### Layers (highest first)

`index.js` → `modal/` → `features/*` → `api/` → `shared/`

- A layer imports only from layers below it.
- `features/*` never import each other. They get `api`, their store slice, shared
  services (toast, dialogs, key bus) and callbacks through the constructor.
- `modal/node/` may import features (it is part of `modal/`), e.g.
  `word-picture-menu` → `features/word-pictures`.

## Building blocks

These are sketches, not the final API. Each one is settled in step 1.

```js
// shared/component.js
export class Component {
  constructor(deps = {}) { this.deps = deps; this.el = null; this._cleanups = []; }
  render() { throw new Error("render() not implemented"); }
  mount(parent) { this.el = this.render(); parent.append(this.el); return this; }
  listen(target, type, fn, opts) { target.addEventListener(type, fn, opts); this._cleanups.push(() => target.removeEventListener(type, fn, opts)); }
  watch(slice, key, fn) { this._cleanups.push(slice.subscribe(key, fn)); }
  own(child) { this._cleanups.push(() => child.destroy()); return child; }
  destroy() { for (const fn of this._cleanups.splice(0).reverse()) fn(); this.el?.remove(); this.el = null; }
}

// shared/store.js
export class Store {
  constructor(initial) { /* { library: {...}, browse: {...}, ... } */ }
  slice(name) { return { get, set, subscribe }; } // a feature only ever sees this
}
```

- `set` replaces values. No in-place `Set` mutation followed by an "announce".
- The store lives on the singleton bag, so cache-busted module copies share it.

Settled in step 1 (the code is the reference):

- `Component.own(x)` takes a child component or a cleanup function; `destroy()`
  runs cleanups last-first and is safe to repeat; `mount()` throws if repeated.
- `Store`: a slice's keys are fixed by the initial state (unknown slice or key
  throws); snapshots are frozen; a subscriber gets `(value, key)` and fires only
  when `Object.is` says the value changed; `"*"` gets the whole slice once per set.
- `shared/keys.js`: `installKeyGuards(root)` returns its uninstall; handlers live
  on the singleton bag, so the bus no longer reads modal state.
- `shared/styles.js`: `useStyles(new URL("./x.css", import.meta.url))` links a
  file once (keyed by path, query ignored); `ensureStyles()` links `tokens.css`,
  then `librarian.css` until step 12 empties it.

Settled in step 2:

- `shared/ui/`: `LayerStack(host, {root})` with `push({el | component, onClose,
  closeOnOutside})`, `pop`, `top`, `clear`, `size`; a pushed component is mounted
  and destroyed by the stack. `Toaster(host)` with `show`, `clear`, `size`.
  `choose(layers, opts)` / `confirm(layers, opts)` open a `ChoiceDialog`.
  `openPopover({anchor, layers, render, ...})` returns a `Popover` component.
  `buildMenu` / `matches` are unchanged.
- Each widget's CSS sits beside it. `ensureStyles()` links the `shared/ui/`
  sheets before `librarian.css`, because unmigrated panes reuse `.pl-dialog` and
  `.pl-popover`, and later rules there still override them.
- The modal builds one `LayerStack` and one `Toaster` in `buildShell()`
  (`inst().layers`, `inst().toaster`; `ctx.layers` exposes the stack).
  `modal/overlays.js` keeps the old `pushLayer`/`toast`/`choiceDialog` functions
  as a shim until step 11.

Settled in step 3:

- The Store lives in `modal/instance.js` (`inst().store`, `slice(name)`), not in
  `app.js`. Every modal module needs it, so it has to sit below `app.js`, or the
  imports would cycle. The slice table is `initialState()` there.
- `modal/app.js` builds `ctx` and translates the panes' flat
  `getState`/`setState`/`subscribe` onto slices (`storageBusy` -> `storage.busy`,
  `dupes` -> the whole dupes slice). `{silent}` is gone: a subscriber that must
  not hear its own write compares against what it wrote (see the inspector's
  `onCurrentChanged`).
- Modal modules use slices directly. `setModalVisible` moved to
  `modal/shell/visibility.js`. `modal/index.js` no longer exports
  `getState`/`setState`/`subscribe`.
- Browse selection replaces its `Set` on every change.

Settled in step 4:

- `features/tags/`: `normalize.js` (`normalizeTag`, `taxonomyRows`, `MAX_TAGS`),
  `tag-picker.js` (`openTagPicker(deps)`, no `ctx`), and `index.js` with
  `createTags({taxonomy, layers, toast})`, the service `app.js` wires in. Other
  features get it as `tags`; legacy panes reach it as `ctx.tags`.
- A feature's `index.js` is its public surface; only `app.js` imports it.

Settled in step 5:

- `features/browse/`: `BrowsePane` (a Component; its root is `display: contents`
  because the rail grid needs the search, chips, tabs and list as its own
  children), `FilterChips`, `SortTabs`, `rows.js`, `selection.js` (on the browse
  slice), the two sources, and two pure modules: `list-keys.js` and
  `search-params.js`. `app.js` `mountList()` builds it, feeds it the threshold
  and current id through `context()`, repaints it on inspector changes, and
  registers it as `ctx.list` (`refresh`, `search`) for the legacy panes.
- The rail's "+ tag" filter is the tags service's multi-select picker
  (`allowNew: false`); `browse/picker.js` and its two fallbacks are gone.
- The browse slice lost `hits`, `hitsTotal` and `loading`: nothing read them.
  Browse no longer writes `library.rev` or `library.total`. Nothing reads `rev`,
  and the taxonomy load sets `total`.
- `VirtualList` is `shared/ui/virtual-list.js`.
- Rail CSS stays in `librarian.css` for now: `.pl-list`, `.pl-row`, `.pl-tabs`
  and `.pl-list-empty` are shared with the versions dialog, `.pl-chip` with the
  inspector, and `.pl-search` with `shared/ui/menu.js`. It gets split in step 9
  or 12, once those owners are settled.
- Open question: the row's "N% match" label is built but never shown (its
  `hidden` is never cleared). Decide whether to show it or drop it.

Settled in step 6:

- `features/dupes/`: `DupesPanel` (owns the dupes slice, the debounce, the
  stale-answer guard, the long-prompt pause, revise and the threshold),
  `ReviseDialog`, `threshold-picker.js` (moved from `pickers/`, now focused and
  keyboard-driven), and `dupes.css` beside them.
- The inspector keeps a `display: contents` slot and calls `ctx.mountDupes(slot,
  {subject, onCompare, onMerge, onOverwrite})`; `app.js` adds the api, slice, lane,
  layers, toast and the rail refresh on a threshold change. The inspector drives
  the panel through `schedule`, `check`, `clear`, `cancel`, `destroy` and
  `threshold`. The save gate (`classifyMatches` in `inspector/save.js`) stays with
  the inspector.
- `matchesOf`, `frac` and `pct` are `shared/matches.js`; `ensureOk` is in
  `api/request.js`. `inspector/records.js` re-exports them until step 8.
- The inspector's fallback popover (`openLocalPopover`) is gone.
- `.pl-dupe-why` stays in `librarian.css`: the compare and merge dialogs use it.

Settled in step 7:

- `features/autocomplete/`: `Autocomplete` (its root is `display: contents`,
  mounted on the modal root outside the card), `SuggestionMenu`, `WordPreview`,
  the pure `completion-context.js` and `completion-position.js`, and
  `autocomplete.css`. The inspector gets it through
  `ctx.attachAutocomplete(textarea, host)`. Keys come through the key bus only;
  the native-listener fallback is gone.
- `shared/pictures.js` is the word-picture map (`wordKey`, `loadWordImages`,
  `rememberPicture`, `forgetPicture`, `pictureOf`); the gallery, the generator
  and the node menu import it directly.
- `dispatchInput` is in `shared/dom.js`, and `pickers/` is deleted.

Settled in step 8:

- `features/inspector/`: `InspectorPane` (a Component; root `display: contents`)
  with explicit deps and no `ctx`: api, its slice, the record lane, caps(),
  layers(), toast, dialogs ({choose, confirm}), drafts ({save, load, clear}), tags,
  mountDupes, attachAutocomplete, compare ({diff, versions, compare}), pushToNode
  and onLibraryChanged. Around it: `view.js` (DOM, handlers passed in), `fields.js`
  (painting), `selection.js` (the unsaved-changes gate, select, new prompt),
  `drafts.js`, `rating.js`, `node-sync.js`, `compare-links.js`,
  `delete-record.js`, `records.js`, and `save/` (`rules.js` pure, `save-flow.js`,
  `conflict-dialog.js`, `match-actions.js`).
- `app.js` `mountInspector()` builds it and registers it as `ctx.inspector`, with
  `isDirty` and `requestSave`, for the modal (close, Ctrl+S, the node binding)
  and the legacy panes. The flat state adapter moved to `modal/legacy-state.js`.
- Gone: `neighbours.js` (compare is wired, not probed), `fallbacks.js` and
  `helpers.js` (shared helpers are imported), `layers.js` (the pane pushes
  components onto the LayerStack and closes them on destroy), the inspector's
  `current` subscription (only the inspector writes `current`), the `{silent}`
  option, and the no-dialog fallback that parked a draft and switched.
- `compare/` is imported statically by `app.js` (no more lazy probing).

Settled in step 9:

- `features/compare/`: `createCompare(deps)` returns `{compare, versions}` and
  opens `CompareDialog`, `MergeEditor` and `VersionsDialog` (all Components) on
  the layer stack. Deps: api, lanes ({diff, versions}), layers(), confirm, toast,
  loadIntoNode, onLibraryChanged, isNarrow(). Around them: `diff-view.js`
  (`DiffView`), `compare-actions.js`, `version-rows.js`, `version-actions.js`,
  `opcodes.js` and `text.js` (pure), `ui.js`, `clipboard.js`, `compare.css`.
- Gone: the `openDiff`/`compareDialog`/`openVersionsDialog`/`versionsDialog`
  aliases; the unused `actions`/`onApplied`/`onClose` options; the local-layer,
  `pl:keydown` and lazy VirtualList fallbacks; the versions debounce on
  `ctx.debounces` (closing the dialog cancels it). The inspector's "diff vs saved"
  calls `compare` (it was always the same dialog).
- CSS: the diff styles moved to `compare.css`. Compare's notes use their own
  `.pl-cmp-note`, so `.pl-dupe-why` moved into `dupes.css`. The versions list
  still borrows `.pl-list`/`.pl-row` from the rail; those get a shared owner in
  step 12.

Settled in step 10:

- `features/word-pictures/`: `startWordPictures({node, app, api, host})` (the node
  menu calls it), `ProgressPanel` (a Component), `runner.js` and `template.js`, and
  `createRenderer({app, host})`: the render service the gallery's A/B compare
  gets through the wiring, so the gallery never imports word-pictures.
- `features/gallery/`: `createGallery(deps)` -> `{open, arrange}` with
  `GalleryDialog`, `WordGrid`, `WordEntry` and `ArrangeDialog`; `words.js` and
  `ab-compare.js` hold the pure parts; `gallery.css`.
- `features/storage/`: `createStorage(deps)` -> the actions plus `open()`, and
  `button()`/`hint()` for the shell. `app.js` builds one per modal
  (`storage()`, `storageControls()`, `openGallery()`); the header and the layout
  ask it for their controls, so the shell never imports a feature.
- `modal/shell/gallery.js` is gone (the button is in `header.js`).
  `modal/shell/glyphs.js` stays: three shell files share it.

Settled in step 11:

- No `ctx`. The mounted panes sit on the instance (`inst().panes.list`,
  `.inspector`); close, Ctrl+S, the node binding and `refreshAll` reach them
  there. `mountPanes()` in `app.js` mounts both statically; a pane that throws
  leaves its note and spares the other. Tests swap in fakes through
  `inst().paneMounters`.
- `ctx.debounces` became `inst().cancelOnClose` (a Set of functions);
  `toast()` moved to `instance.js`; shell and target code use `inst().layers`.
  `modal/index.js` keeps `openModal`, `setHost`, the close functions,
  `refreshAll` and the target helpers; `ctx`, `toast` and the layer functions left it.
- `modal/library.js` and `modal/drafts.js` replace `modal/library/`.
- `modal/node/`: the lazy imports became static (`api/` was already loaded
  eagerly by `live-meta.js`). `text-sync.js` (435 lines) is now `text-access.js`
  (read), `text-watch.js` (the three watch mechanisms) and `text-sync.js`
  (write, plus the public names).
- Deleted as dead once `ctx` went: `shared/index.js` (only `ctx.dom`),
  `api/index.js` (only the lazy imports) and `shared/widgets.js` (no caller).
- The structure test bans the `ctx` identifier; `LEGACY` holds only
  `librarian.css` until step 12. The tests for the lazy pane-import races and
  the flat state API went with that code.

Settled in step 12:

- `librarian.css` is gone. The rules with more than one consumer are `shared/ui/`
  sheets: `base.css` (resets, scrollbars, reduced motion), `link.css`,
  `search.css`, `chip.css`, `tabs.css`, `list.css` (`.pl-list`/`.pl-row`, the
  shared owner the rail and the versions dialog needed, plus `.pl-badge-dupe`),
  `text-area.css`, `stars.css` and `button.css`. `ensureStyles()` links them
  after the overlay sheets, in the order the rules had in `librarian.css`.
- The rest sits beside its owner, linked with `useStyles`: `modal/shell/shell.css`
  and `responsive.css` (by `buildShell`), `modal/node/node-card.css` (by the face),
  `features/browse/browse.css` and `features/inspector/inspector.css` (by the panes).
- `link.css` keeps both `.pl-link` blocks in their old order: every link gets the
  second block's refinements, the header toggle included.
- Four rules had no element left to style and were dropped: `.pl-sr`, `.pl-input`
  (with its `:focus`) and `.pl-mark`.
- `python3 scripts/dev.py widgets` serves `devharness/widgets.html` at
  `/__dev/widgets`: every `shared/ui` widget built from the pack's modules on a
  bare `.pl-root`, with only the shared sheets linked.
- The structure test's allowlist is gone with the last legacy path.

### Store slices (from today's `freshState()`)

| Slice | Owner | Keys |
|---|---|---|
| `library` | `modal/library.js` | rev, total, tagCount, tags, caps |
| `shell` | `modal/` | targetNodeId, targetOk, target, link |
| `browse` | `features/browse` | query, hits, hitsTotal, loading, selection, selectionMode, anchorIndex |
| `inspector` | `features/inspector` | currentId, current, baseline, buffer |
| `dupes` | `features/dupes` | threshold, matches, loading |
| `storage` | `features/storage` | storage, busy |

### Wiring example (`modal/app.js`)

```js
const inspector = new Inspector({ api, slice: store.slice("inspector"), toast, dialogs,
                                  onSaved: () => browse.refresh() });
const browse = new BrowsePane({ api, slice: store.slice("browse"), tags,
                                onSelect: (id) => inspector.select(id) });
```

## Old → new mapping

| Today | Target |
|---|---|
| `index.js` | `index.js` (imports `modal/node/` instead of `node/`) |
| `api/*` | `api/*` (unchanged) |
| `shared/*` | `shared/*` |
| `modal/state.js`, `modal/context.js` | `shared/store.js` + `modal/app.js`; `ctx` deleted |
| `modal/input/keys.js` | `shared/keys.js` |
| `modal/input/focus.js`, `shortcuts.js` | `modal/input/` |
| `modal/overlays/dialogs.js`, `layers.js`, `toasts.js` | `shared/ui/dialog.js`, `layer-stack.js`, `toast.js` |
| `modal/shell/*` | `modal/shell/*` (`gallery.js` and `glyphs.js` fold into `header.js`) |
| `modal/lifecycle/open.js`, `close.js` | `modal/lifecycle/` |
| `modal/lifecycle/panes.js` | deleted (static imports in `app.js`) |
| `modal/library/data.js`, `drafts.js` | `modal/library.js`, `modal/drafts.js` |
| `modal/target/*` | `modal/target/*` |
| `modal/storage/*` | `features/storage/` |
| `node/*` | `modal/node/*` |
| `browse/*` | `features/browse/*` |
| `browse/virtual-list.js` | `shared/ui/virtual-list.js` (browse + versions use it) |
| `browse/picker.js` | deleted (fallback); browse gets `tags` from wiring |
| `inspector/index.js` (756 lines) | `features/inspector/inspector.js` + split helpers |
| `inspector/save.js` (480 lines) | `features/inspector/save/` (directory if > 300 lines) |
| `inspector/view.js`, `records.js`, `drafts.js`, `constants.js` | `features/inspector/` |
| `inspector/dupes.js` | `features/dupes/` |
| `inspector/autocomplete*.js`, `completion-*.js` | `features/autocomplete/` |
| `inspector/word-preview.js` | cache → `shared/pictures.js`; preview → `features/autocomplete/` |
| `inspector/neighbours.js`, `fallbacks.js`, `helpers.js`, `layers.js` | deleted (wiring and static imports replace them) |
| `compare/*` | `features/compare/` (split `versions.js` 619 and `compare.js` 497) |
| `compare/index.js` aliases | deleted |
| `gallery/*` | `features/gallery/*` |
| `word-pictures/*` | `features/word-pictures/*` |
| `pickers/popover.js`, `menu.js`, `caret.js`, `common.js` | `shared/ui/popover.js`, `menu.js`; caret helpers → `shared/dom.js` |
| `pickers/tags.js` | `features/tags/` |
| `pickers/threshold.js` | `features/dupes/` |
| `pickers/wildcards.js`, `snippets.js`, `mirror.js`, `tokenize.js` | deleted |
| `librarian.css` (2197 lines) | `shared/ui/tokens.css` + one `.css` per component/feature |

## Structure test additions (`tests-js/structure.test.js`)

- `features/<a>/` never imports `features/<b>/`.
- `shared/` imports only `shared/`. `api/` imports only `api/` and `shared/`.
- `features/` never import `modal/` or `index.js`. Only `modal/app.js` and
  `modal/node/` import from `features/`.
- No dynamic `import()` except `index.js` → `modal/index.js`.
- No file over 300 lines (a CSS ceiling too, so the stylesheet split holds).
- No `ctx` parameter or `ctx.` access left (once step 11 lands).

Until the last step, the test keeps an allowlist of legacy directories that shrinks
with each step. Each step deletes its directory from the allowlist.

## Migration steps

Each step: move one slice, update `tests-js/` paths and harness, then
`npm test` and `python3 scripts/dev.py sim` must stay green.

1. ✅ **Foundations.** Add `shared/component.js`, `shared/store.js`, `shared/keys.js`, the
   CSS loader and `shared/ui/tokens.css`. Add the structure-test rules with the legacy
   allowlist. Delete wildcards, snippets, mirror and tokenize from the frontend.
2. ✅ **Overlays to `shared/ui/`.** Dialog, layer stack, toast, popover, menu. The old
   `ctx` keeps working as a thin shim over them during the migration.
3. ✅ **`modal/app.js` + Store.** It replaces `state.js` with slices; `ctx` becomes a
   shim built by `app.js`.
4. ✅ **`features/tags/`.**
5. ✅ **`features/browse/`** plus `shared/ui/virtual-list.js`.
6. ✅ **`features/dupes/`** (out of the inspector, with the threshold picker).
7. ✅ **`features/autocomplete/`** plus `shared/pictures.js`.
8. ✅ **`features/inspector/`.** Split `index.js` and `save.js`, and delete
   `neighbours.js`, `fallbacks.js` and `helpers.js`.
9. ✅ **`features/compare/`.** Split `versions.js` and `compare.js`, and drop the aliases.
10. ✅ **`features/storage/`, `features/gallery/`, `features/word-pictures/`.**
11. ✅ **`modal/node/`.** Delete the `ctx` shim and `lifecycle/panes.js`; empty the
    allowlist.
12. ✅ **CSS split finished.** Add a dev gallery page (a new `scripts/dev.py` mode) that
    renders every `shared/ui/` widget in isolation.

## Out of scope

- `web/prompt_store/` (the older node).
- The backend, the HTTP API and the SQLite schema.
- The tags rework (after this migration).
