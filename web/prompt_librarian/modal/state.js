import { NS } from "../shared/ns.js";
import { singleton } from "../shared/singleton.js";

import { readLinkPref } from "./target/preferences.js";

export function freshState() {
  return {
    rev: 0,
    total: 0,
    tagCount: 0,
    tags: [], // [{name, count}]
    query: { q: "", tags: [], dupesOnly: false, sort: "relevance" },
    hits: [],
    hitsTotal: 0,
    loading: false,
    selection: new Set(),
    selectionMode: "ids", // "ids" | "filter"
    anchorIndex: null,
    currentId: null, // set the instant a row is clicked, before the fetch lands
    current: null, // canonical record as loaded from the server
    baseline: null, // snapshot for dirty comparison
    buffer: { tags: [], body: "" },
    dupes: { threshold: 0.9, matches: [], loading: false },
    caps: {},
    storage: null,
    storageBusy: false,
    targetNodeId: null,
    targetOk: true,
    target: { label: "", hasNodes: false },
    link: readLinkPref(), // two-way binding between the textarea and the node
  };
}

/* Keep state on the shared bag across cache-busted module instances.
 */

export function inst() {
  return singleton("modal", () => ({
    built: false,
    wired: false,
    open: false,
    session: null, // identity token invalidated on close
    opening: null, // initialization shared by concurrent opens
    paneLoads: {}, // pending independent optional-module imports
    root: null,
    els: {},
    state: freshState(),
    subs: new Map(), // key -> Set<fn>
    toastCleanup: new Set(),
    layers: [], // [{el, onClose, closeOnOutside}]
    keyHandlers: new WeakMap(), // element -> {type: [{fn, capture}]}
    teardown: [], // functions run by closeModal()
    ro: null,
    heartbeat: 0,
    previouslyFocused: null,
    ctx: null,
    mounted: { list: false, inspector: false },
    backdropDown: false,
    closing: false, // a save-on-close is in flight; see modal/lifecycle/close.js
    binding: null, // {nodeId, node, unbind} — see modal/target/binding.js
  }));
}

/** Set visibility and aria-modal together. ComfyUI blocks shortcuts for any
 * [role="dialog"][aria-modal="true"], even when hidden.
 */
export function setModalVisible(visible) {
  const it = inst();
  const card = it.els && it.els.card;
  if (card) {
    if (visible) card.setAttribute("aria-modal", "true");
    else card.removeAttribute("aria-modal");
  }
  if (it.root) it.root.hidden = !visible;
}


export function getState() {
  return inst().state;
}

/** Notify for every patched key, even equal references: callers mutate Sets
 * in place and use setState to announce those changes.
 *
 * @param {object} patch
 * @param {{silent?: boolean}} [opts]
 */
export function setState(patch, opts = {}) {
  const it = inst();
  if (!patch || typeof patch !== "object") return it.state;
  const keys = Object.keys(patch);
  for (const key of keys) it.state[key] = patch[key];
  if (!opts.silent) notify(keys);
  return it.state;
}

function notify(keys) {
  const it = inst();
  const seen = new Set();
  for (const key of keys) {
    const set = it.subs.get(key);
    if (set) for (const fn of Array.from(set)) seen.add(fn);
  }
  const star = it.subs.get("*");
  if (star) for (const fn of Array.from(star)) seen.add(fn);
  for (const fn of seen) {
    try {
      fn(it.state);
    } catch (err) {
      console.error(`${NS} subscriber failed`, err);
    }
  }
}

/**
 * @param {string} key a top-level state key, or "*" for every change
 * @param {(state: object) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(key, fn) {
  const it = inst();
  if (typeof fn !== "function") return () => {};
  let set = it.subs.get(key);
  if (!set) {
    set = new Set();
    it.subs.set(key, set);
  }
  set.add(fn);
  return () => {
    const s = inst().subs.get(key);
    if (s) s.delete(fn);
  };
}
