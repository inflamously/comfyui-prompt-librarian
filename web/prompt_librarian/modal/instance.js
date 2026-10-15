/* The modal's runtime instance: shell handles, the open session, layers,
 * teardown steps and the Store. It lives on the page-wide singleton bag, so
 * cache-busted module copies share one modal instead of building a second.
 */

import { NS } from "../shared/ns.js";
import { singleton } from "../shared/singleton.js";
import { Store } from "../shared/store.js";
import { readLinkPref } from "./target/preferences.js";

/** Every slice and its starting values; a slice's keys are fixed here. */
export function initialState() {
  return {
    library: { rev: 0, total: 0, tagCount: 0, tags: [], caps: {} }, // tags: [{name, count}]
    shell: {
      targetNodeId: null,
      targetOk: true,
      target: { label: "", hasNodes: false },
      link: readLinkPref(), // two-way binding between the textarea and the node
    },
    browse: {
      query: { q: "", tags: [], dupesOnly: false, sort: "relevance" },
      selection: new Set(), // replaced on every change, never mutated
      selectionMode: "ids", // "ids" | "filter"
      anchorIndex: null,
    },
    inspector: {
      currentId: null, // set the instant a row is clicked, before the fetch lands
      current: null, // canonical record as loaded from the server
      baseline: null, // snapshot for dirty comparison
      buffer: { tags: [], body: "" },
    },
    dupes: { threshold: 0.9, matches: [], loading: false },
    storage: { storage: null, busy: false },
  };
}

/** The shared instance, created on first use. */
export function inst() {
  return singleton("modal", () => ({
    built: false,
    wired: false,
    open: false,
    session: null, // identity token invalidated on close
    opening: null, // initialization shared by concurrent opens
    root: null,
    els: {},
    store: new Store(initialState()),
    layers: null, // LayerStack, built with the shell
    toaster: null, // Toaster, built with the shell
    services: {}, // feature services built once per modal (storage, gallery)
    teardown: [], // functions run by closeModal()
    ro: null,
    heartbeat: 0,
    previouslyFocused: null,
    panes: { list: null, inspector: null }, // the mounted BrowsePane and InspectorPane
    paneMounters: null, // {list(el), inspector(el)} replacing app.js's, for tests
    cancelOnClose: new Set(), // pending debounces closeModal() cancels
    backdropDown: false,
    closing: false, // a save-on-close is in flight; see modal/lifecycle/close.js
    binding: null, // {nodeId, node, unwatch} — see modal/target/binding.js
  }));
}

/** One slice of the modal's Store. */
export function slice(name) {
  return inst().store.slice(name);
}

/** Show a toast on the modal's toaster; logs instead before the shell is built. */
export function toast(message, opts = {}) {
  const { toaster } = inst();
  if (toaster) return toaster.show(message, opts);
  console.info(`${NS} ${opts.kind || "info"}: ${message}`);
  return null;
}
