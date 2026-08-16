/* ==========================================================================
   Prompt Librarian — the modal instance and its state store
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only. The
   modal is built on the first `openModal()` and never before.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { singleton } from "../shared/singleton.js";

/** localStorage key for the link toggle. Survives a reload; not per-workflow. */
const LINK_KEY = "pl:link";

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
    targetNodeId: null,
    targetOk: true,
    link: readLinkPref(), // two-way binding between the textarea and the node
  };
}

/**
 * The link toggle, persisted. Defaults to ON: a panel that silently disagrees
 * with the node it is pointing at is the bug this whole binding exists to fix,
 * so the safe state is "mirrored" and unlinking is the deliberate act.
 */
export function readLinkPref() {
  try {
    if (typeof localStorage === "undefined") return true;
    const raw = localStorage.getItem(LINK_KEY);
    return raw == null ? true : raw !== "0";
  } catch (_) {
    return true; // private mode / blocked storage — the default still applies
  }
}

export function writeLinkPref(on) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LINK_KEY, on ? "1" : "0");
  } catch (_) {
    /* best effort — the toggle still works for this session */
  }
}

/* --------------------------------------------------------------------------
   The instance
   --------------------------------------------------------------------------
   Held on the shared singleton bag, NOT in a module-level `let`: ComfyUI
   cache-busts extension module URLs and the module registry is keyed on the
   full URL, so `state.js?v=1` and `state.js?v=2` are two module instances with
   two sets of module-level bindings — and would build two modals, install two
   key guards and stack two toast containers.
   -------------------------------------------------------------------------- */

export function inst() {
  return singleton("modal", () => ({
    built: false,
    wired: false,
    open: false,
    root: null,
    els: {},
    state: freshState(),
    subs: new Map(), // key -> Set<fn>
    layers: [], // [{el, onClose, closeOnOutside}]
    keyHandlers: new WeakMap(), // element -> {type: [{fn, capture}]}
    teardown: [], // functions run by closeModal()
    ro: null,
    heartbeat: 0,
    previouslyFocused: null,
    ctx: null,
    mounted: { list: false, inspector: false },
    backdropDown: false,
    closing: false, // a save-on-close is in flight; see modal/close.js
    binding: null, // {nodeId, node, unbind} — see modal/binding.js
  }));
}

/* --------------------------------------------------------------------------
   Store: getState / setState / subscribe
   -------------------------------------------------------------------------- */

export function getState() {
  return inst().state;
}

/**
 * Merge a patch into the state and notify subscribers.
 *
 * Every key present in the patch counts as changed, even if the value is
 * identical by reference — callers routinely mutate a `Set` in place and then
 * `setState({selection})` to announce it, and an equality check would swallow
 * exactly those updates.
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
