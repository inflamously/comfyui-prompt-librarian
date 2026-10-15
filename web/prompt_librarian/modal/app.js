/* Composition root of the modal: it builds every feature with its slice, the
 * shared services and the callbacks that connect it to the others. Features
 * never import each other; whatever one needs from another passes through here.
 *
 * The mounted panes live on the instance (`inst().panes`), so the modal's
 * lifecycle (close, Ctrl+S, the node binding) reaches them without importing
 * this module. The inspector's requestSave returns save-flow status strings;
 * only "saved" and "clean" permit closing.
 */

import { NS } from "../shared/ns.js";
import { clear, h } from "../shared/dom.js";
import { warnOnce } from "../shared/singleton.js";
import { comfy } from "../api/request.js";
import { lanes } from "../api/lanes.js";
import { caps } from "../api/caps.js";
import { API } from "../api/routes.js";
import { inst, slice, toast } from "./instance.js";
import { pushToNode } from "./target/binding.js";
import { refreshAll, reportError } from "./library.js";
import { clearDraft, loadDraft, saveDraft } from "./drafts.js";
import { hostApp } from "./target/host.js";
import { getTargetNodeId } from "./target/nodes.js";
import { loadIntoNode } from "./target/load.js";
import { choose, confirm } from "../shared/ui/dialog.js";
import { Autocomplete } from "../features/autocomplete/index.js";
import { BrowsePane } from "../features/browse/index.js";
import { createCompare } from "../features/compare/index.js";
import { DupesPanel } from "../features/dupes/index.js";
import { createGallery } from "../features/gallery/index.js";
import { InspectorPane } from "../features/inspector/index.js";
import { createStorage } from "../features/storage/index.js";
import { createTags } from "../features/tags/index.js";
import { createRenderer } from "../features/word-pictures/index.js";

const layers = () => inst().layers;
const dialogs = {
  choose: (opts) => choose(layers(), opts),
  confirm: (opts) => confirm(layers(), opts),
};

/* ---- panes ------------------------------------------------------------------ */

const PANES = [
  { key: "list", element: "rail", message: "the browser rail is unavailable" },
  { key: "inspector", element: "inspect", message: "the prompt inspector is not available yet" },
];

/** Mount the rail and the inspector once; a pane that throws leaves a note and spares its sibling. */
export function mountPanes() {
  const it = inst();
  const mounters = it.paneMounters || { list: mountList, inspector: mountInspector };
  for (const pane of PANES) {
    if (it.panes[pane.key]) continue;
    const el = it.els[pane.element];
    try {
      const mounted = mounters[pane.key](el);
      it.panes[pane.key] = mounted;
      mounted.own?.(() => { if (it.panes[pane.key] === mounted) it.panes[pane.key] = null; });
    } catch (err) {
      warnOnce(`${pane.key}-missing`, `${pane.key} pane failed to mount`, err);
      clear(el);
      el.appendChild(h("div", { className: "pl-list-empty" }, pane.message));
    }
  }
}

/** Show a prompt in the inspector; the rail marks it at once, before the fetch lands. */
function selectPrompt(id) {
  slice("inspector").set({ currentId: id == null ? null : String(id) });
  inst().panes.inspector?.selectPrompt(id).catch((err) => console.error(`${NS} selectPrompt failed`, err));
}

/** Keep `cancel` in the set closeModal() runs until `owner` is destroyed. */
function cancelOnClose(owner, cancel) {
  const set = inst().cancelOnClose;
  set.add(cancel);
  owner.own(() => set.delete(cancel));
}

/** Build the browse rail into `el`. */
function mountList(el) {
  const inspector = slice("inspector");
  const browse = new BrowsePane({
    api: API,
    slice: slice("browse"),
    tags: tags(),
    context: () => ({ threshold: slice("dupes").get("threshold"), currentId: inspector.get("currentId") }),
    onSelect: selectPrompt,
    onLoad: (record) => loadIntoNode(record),
    toast,
    reportError,
  });
  el.replaceChildren();
  browse.mount(el);
  browse.own(inspector.subscribe("currentId", () => browse.repaint()));
  browse.own(inspector.subscribe("current", () => browse.repaint()));
  cancelOnClose(browse, () => browse.cancelPending());
  return browse;
}

/**
 * Build a duplicate panel into `slot` for the inspector. The inspector supplies
 * its side ({subject, onCompare, onMerge, onOverwrite}); everything else is wired here.
 */
function mountDupes(slot, inspectorSide) {
  const panel = new DupesPanel({
    ...inspectorSide,
    api: API,
    slice: slice("dupes"),
    lane: (run) => lanes.dupe(run),
    layers,
    toast,
    // The list's duplicate counts must agree with the panel.
    onThreshold: () => inst().panes.list?.refresh({ reset: true }) ?? refreshAll(),
  }).mount(slot);
  cancelOnClose(panel, () => panel.cancel());
  return panel;
}

/** Attach completion to the inspector's editor. The menu is mounted on the modal
 * root, outside the card, whose layout containment would offset a fixed menu. */
export function attachAutocomplete(textarea, host) {
  return new Autocomplete({ textarea, api: API, caps, lane: lanes.autocomplete })
    .mount(host.closest(".pl-root") || host);
}

/** Build the inspector into `el`. */
function mountInspector(el) {
  const pane = new InspectorPane({
    api: API,
    slice: slice("inspector"),
    lane: lanes.record,
    caps: () => caps,
    layers,
    toast,
    dialogs,
    drafts: { save: saveDraft, load: loadDraft, clear: clearDraft },
    tags: tags(),
    mountDupes,
    attachAutocomplete,
    compare: createCompare({
      api: API,
      lanes: { diff: lanes.diff, versions: lanes.versions },
      layers,
      confirm: dialogs.confirm,
      toast,
      loadIntoNode,
      onLibraryChanged: () => refreshAll(),
      isNarrow: () => inst().root?.dataset.w === "narrow",
    }),
    pushToNode,
    onLibraryChanged: () => refreshAll(),
  });
  el.replaceChildren();
  pane.mount(el);
  pane.own(slice("library").subscribe("caps", () => pane.refreshCaps()));
  cancelOnClose(pane, () => pane.draftTimer.cancel());
  return pane;
}

/* ---- services built once per modal --------------------------------------- */

/** The tag picker and normalisation, over the library's taxonomy. */
function tags() {
  return (inst().services.tags ??= createTags({
    taxonomy: () => slice("library").get("tags"),
    layers,
    toast,
  }));
}

/** Storage: status, compaction, migration, JSON export and import. */
export function storage() {
  const it = inst();
  return (it.services.storage ??= createStorage({
    api: API,
    slice: slice("storage"),
    caps: () => slice("library").get("caps") || {},
    layers,
    choose: dialogs.choose,
    toast,
    reportError,
    onLibraryChanged: () => refreshAll(),
    isOpen: () => inst().open,
    session: () => inst().session,
  }));
}

/** The storage link and hint for the shell's header and footer, repainted on caps changes. */
export function storageControls() {
  const svc = storage();
  const button = svc.button().mount(document.createDocumentFragment());
  const hint = svc.hint().mount(document.createDocumentFragment());
  slice("library").subscribe("caps", () => { button.paint(); hint.paint(); });
  return { button: button.el, hint: hint.el };
}

/** Open the word gallery. */
export function openGallery() {
  const it = inst();
  it.services.gallery ??= createGallery({
    api: API,
    layers,
    toast,
    reportError,
    confirm: dialogs.confirm,
    onFind: (text) => inst().panes.list?.search(text),
    base: () => inst().panes.inspector?.getBuffer().body || "",
    nodeId: () => getTargetNodeId(),
    renderer: createRenderer({ app: () => hostApp(), host: comfy }),
    viewImage: (ref) => comfy.view(ref),
  });
  return it.services.gallery.open();
}
