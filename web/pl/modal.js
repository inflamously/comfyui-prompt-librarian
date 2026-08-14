/* ==========================================================================
   Prompt Librarian — modal shell, state store, key isolation
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only. The
   modal is built on the first `openModal()` and never before.

   This module owns:
     - the overlay DOM (header / rail / inspector / footer / layers / toasts)
     - the state store and its subscriptions
     - KEY ISOLATION (read the long comment above installKeyGuards — it is the
       single most likely thing to be broken by a future edit)
     - the layer stack, focus trap, toasts and the basic confirm dialog
     - target-node resolution and `Load into node`

   It does NOT own the rail (list.js) or the inspector (inspector.js). Both are
   imported lazily, inside try/catch, so a missing or broken module degrades to
   a placeholder instead of an empty modal.
   ========================================================================== */

import * as dom from "./dom.js";
import {
  NS,
  cls,
  clear,
  ensureStyles,
  fmtInt,
  h,
  singleton,
  singletonBag,
  warnOnce,
} from "./dom.js";
import { API, ABORTED, ApiError, caps, cancelAllLanes, invalidateMeta, lanes } from "./api.js";

const NODE_CLASS = "PromptLibrarian";
const NARROW_AT = 900;
const HEARTBEAT_MS = 1000;
const DRAFT_PREFIX = "pl:draft:";
const ARROW = String.fromCharCode(0x2192); // "→"
const MIDDOT = String.fromCharCode(0x00b7); // "·"
const CARET = String.fromCharCode(0x25be); // "▾"
const TIMES = String.fromCharCode(0x00d7); // "×"

/* --------------------------------------------------------------------------
   Host
   -------------------------------------------------------------------------- */

/**
 * The host bag is shared with web/pl_librarian.js (same singleton key), which
 * assigns `app` in its `setup()`. Modules under pl/ never import the entry
 * file — that would re-run `registerExtension` under a second cache-busted
 * URL — so this bag is the handoff.
 */
function host() {
  return singleton("host", () => ({ app: null }));
}

/** Called once from the extension entry. */
export function setHost(hostObj) {
  if (hostObj && hostObj.app) host().app = hostObj.app;
}

function hostApp() {
  return host().app || null;
}

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

function freshState() {
  return {
    rev: 0,
    total: 0,
    catCount: 0,
    categories: [], // [{name, count}]
    tags: [], // [{name, count}]
    query: { q: "", category: null, tags: [], dupesOnly: false, sort: "relevance" },
    hits: [],
    hitsTotal: 0,
    loading: false,
    selection: new Set(),
    selectionMode: "ids", // "ids" | "filter"
    anchorIndex: null,
    currentId: null, // set the instant a row is clicked, before the fetch lands
    current: null, // canonical record as loaded from the server
    baseline: null, // snapshot for dirty comparison
    buffer: { name: "", category: null, tags: [], body: "" },
    dupes: { threshold: 0.9, matches: [], loading: false },
    caps: {},
    targetNodeId: null,
    targetOk: true,
  };
}

/* --------------------------------------------------------------------------
   The instance
   --------------------------------------------------------------------------
   Held on the shared singleton bag, NOT in a module-level `let`: ComfyUI
   cache-busts extension module URLs and the module registry is keyed on the
   full URL, so `modal.js?v=1` and `modal.js?v=2` are two module instances with
   two sets of module-level bindings — and would build two modals, install two
   key guards and stack two toast containers.
   -------------------------------------------------------------------------- */

function inst() {
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
    dirtyBar: null,
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

/* ==========================================================================
   KEY ISOLATION — THE TOP HAZARD IN THIS PACK. READ BEFORE EDITING.
   --------------------------------------------------------------------------
   While the user types in our textarea, ComfyUI is still listening: Delete
   removes the selected node, Ctrl+Z undoes the graph, Space pans the canvas,
   Ctrl+A selects every node. Any of those firing mid-sentence silently
   corrupts the user's workflow.

   TWO LAYERS, because a `document`-capture listener registered by ComfyUI at
   boot runs before anything we could bind on our own root:

   Layer A — window CAPTURE. The capture phase runs window -> document -> ...
     -> our root -> target, so a listener on `window` in the capture phase is
     the FIRST thing to see the event, ahead of any document/body/canvas
     listener regardless of registration order. When the event originates
     inside our root we call stopImmediatePropagation() and the outside world
     never learns a key was pressed.

   Layer B — root-level BUBBLE stops, for the (many) handlers bound on body or
     the canvas in the bubble phase. Defence in depth: if Layer A ever fails to
     install, this still catches everything that bubbles.

   `stopPropagation` ONLY — NEVER `preventDefault` on the guard. Text entry,
   IME composition and clipboard actions are DEFAULT ACTIONS, not listeners;
   preventing them breaks typing outright. Escape is the single exception, and
   it is handled explicitly further down.

   CONSEQUENCE YOU MUST KNOW ABOUT: Layer A stops the event before it ever
   reaches our own subtree, so `el.addEventListener("keydown", …)` INSIDE the
   modal never fires. That is inherent — you cannot both beat a document
   capture listener and let the event continue. Two supported ways to receive
   keys inside the modal:

     1. `ctx.onKey(el, "keydown", fn)` — the internal bus below re-delivers the
        real event along the path from `e.target` up to `.pl-root`, honouring
        capture/bubble order, `stopPropagation()` and `preventDefault()` (which
        works because we deliver the ORIGINAL event object, not a copy).
     2. Listen for the namespaced mirror `"pl:keydown"` / `"pl:keyup"` /
        `"pl:keypress"`, a bubbling CustomEvent dispatched on the same target
        with `detail.event` pointing at the original. Nothing outside this pack
        listens for those types, so they are harmless if they escape; calling
        `preventDefault()` on the mirror forwards to the original.

   Both layers are torn down on close WITH THE IDENTICAL CAPTURE FLAG —
   removeEventListener only matches a listener whose capture flag is the same,
   and a leaked window-capture guard would swallow every keystroke on the page
   for the rest of the session.
   ========================================================================== */

const KEY_TYPES = ["keydown", "keyup", "keypress"];
const BUBBLE_STOP_TYPES = [
  "keydown",
  "keyup",
  "keypress",
  "wheel", // stopped, never prevented: scrolling the list must not zoom the canvas
  "pointerdown",
  "contextmenu",
  "copy",
  "paste",
  "cut",
  "dragstart",
];

/**
 * Register a key handler that survives the capture guard.
 * @returns {() => void} unregister
 */
function onKey(el, type, fn, opts = {}) {
  if (!el || typeof fn !== "function") return () => {};
  const it = inst();
  let map = it.keyHandlers.get(el);
  if (!map) {
    map = Object.create(null);
    it.keyHandlers.set(el, map);
  }
  const list = map[type] || (map[type] = []);
  const entry = { fn, capture: !!opts.capture };
  list.push(entry);
  return () => {
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Re-deliver `e` to bus handlers between `.pl-root` and `e.target`. */
function deliverKey(e) {
  const it = inst();
  const root = it.root;
  if (!root) return;

  // Path from target up to root (inclusive). If the target is not under root
  // the caller should not have called us.
  const path = [];
  for (let n = e.target; n; n = n.parentNode) {
    path.push(n);
    if (n === root) break;
  }
  if (path[path.length - 1] !== root) return;

  let stopped = false;
  let immediate = false;

  // Shadow the propagation methods with own properties so a handler written
  // against the normal DOM contract keeps working. `preventDefault` is NOT
  // shadowed — it must reach the real event, which is the whole reason we
  // deliver the original object rather than a clone.
  const hadStop = Object.prototype.hasOwnProperty.call(e, "stopPropagation");
  const hadStopAll = Object.prototype.hasOwnProperty.call(e, "stopImmediatePropagation");
  try {
    e.stopPropagation = () => {
      stopped = true;
    };
    e.stopImmediatePropagation = () => {
      stopped = true;
      immediate = true;
    };

    const run = (node, capture) => {
      const map = it.keyHandlers.get(node);
      const list = map && map[e.type];
      if (!list || !list.length) return;
      for (const entry of Array.from(list)) {
        if (immediate) return;
        if (entry.capture !== capture) continue;
        try {
          entry.fn(e);
        } catch (err) {
          console.error(`${NS} key handler failed`, err);
        }
      }
    };

    // capture: root -> target
    for (let i = path.length - 1; i >= 0 && !stopped; i--) run(path[i], true);
    // bubble: target -> root
    for (let i = 0; i < path.length && !stopped; i++) run(path[i], false);
  } finally {
    if (!hadStop) delete e.stopPropagation;
    if (!hadStopAll) delete e.stopImmediatePropagation;
  }

  // Namespaced mirror for code that prefers plain addEventListener. Unknown
  // event types are inert everywhere else on the page.
  if (typeof CustomEvent === "function") {
    try {
      const mirror = new CustomEvent("pl:" + e.type, {
        bubbles: true,
        cancelable: true,
        detail: { event: e },
      });
      const ok = e.target.dispatchEvent(mirror);
      if (!ok && typeof e.preventDefault === "function") e.preventDefault();
    } catch (_) {
      /* CustomEvent unavailable or target detached — the bus already ran */
    }
  }
}

function installKeyGuards() {
  const it = inst();
  const root = it.root;
  if (!root || typeof window === "undefined") return;

  // ---- Layer A: window CAPTURE ------------------------------------------
  const guard = (e) => {
    const t = e.target;
    // `contains` covers text nodes and the root itself; a target of `window`
    // or `document` (some synthetic events) is correctly excluded.
    if (!t || typeof root.contains !== "function" || !root.contains(t)) return;
    e.stopImmediatePropagation(); // never preventDefault here
    deliverKey(e);
  };
  for (const type of KEY_TYPES) window.addEventListener(type, guard, true);
  it.teardown.push(() => {
    // IDENTICAL capture flag — removeEventListener will not match otherwise.
    for (const type of KEY_TYPES) window.removeEventListener(type, guard, true);
  });

  // ---- Layer B: root-level bubble stops ----------------------------------
  const stop = (e) => e.stopPropagation(); // never stopImmediatePropagation:
  // our own root-level listeners (registered after this one) must still run.
  for (const type of BUBBLE_STOP_TYPES) root.addEventListener(type, stop, false);
  it.teardown.push(() => {
    for (const type of BUBBLE_STOP_TYPES) root.removeEventListener(type, stop, false);
  });
}

/* --------------------------------------------------------------------------
   Focus trap
   -------------------------------------------------------------------------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return [];
  const out = [];
  for (const el of scope.querySelectorAll(FOCUSABLE)) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") continue;
    if (el.offsetParent === null && el.getAttribute("tabindex") === null) continue;
    out.push(el);
  }
  return out;
}

/** The element the trap applies to: the top layer, else the card. */
function trapScope() {
  const it = inst();
  const top = it.layers[it.layers.length - 1];
  return (top && top.el) || it.els.card || it.root;
}

function handleTab(e) {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  // Do not fight ComfyUI's own dialogs — if focus is inside one, stand down.
  if (active && typeof active.closest === "function" && active.closest(".comfy-modal, .p-dialog")) {
    return;
  }
  const scope = trapScope();
  const list = focusables(scope);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const inScope = active && scope.contains(active);
  if (!inScope) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/* --------------------------------------------------------------------------
   Layer stack
   -------------------------------------------------------------------------- */

/**
 * Push a layer (popover, sub-dialog) onto `.pl-layers`.
 * @param {{el: HTMLElement, onClose?: () => void, closeOnOutside?: boolean}} opts
 * @returns {object} handle for popLayer()
 */
export function pushLayer(opts) {
  const it = inst();
  if (!it.built || !opts || !opts.el) return null;
  const handle = {
    el: opts.el,
    onClose: typeof opts.onClose === "function" ? opts.onClose : null,
    closeOnOutside: opts.closeOnOutside !== false,
    restoreFocus: typeof document !== "undefined" ? document.activeElement : null,
  };
  it.layers.push(handle);
  it.els.layers.appendChild(opts.el);
  const first = focusables(opts.el)[0];
  if (first) {
    try {
      first.focus();
    } catch (_) {
      /* ignore */
    }
  }
  return handle;
}

/** Remove a layer (default: the top one) and run its onClose. */
export function popLayer(handle) {
  const it = inst();
  const target = handle || it.layers[it.layers.length - 1];
  if (!target) return;
  const i = it.layers.indexOf(target);
  if (i < 0) return;
  it.layers.splice(i, 1);
  try {
    if (target.el && target.el.parentNode) target.el.parentNode.removeChild(target.el);
  } catch (_) {
    /* ignore */
  }
  if (target.onClose) {
    try {
      target.onClose();
    } catch (err) {
      console.error(`${NS} layer onClose failed`, err);
    }
  }
  const back = target.restoreFocus;
  if (back && typeof back.focus === "function" && it.root && it.root.contains(back)) {
    try {
      back.focus();
    } catch (_) {
      /* ignore */
    }
  }
}

export function topLayer() {
  const it = inst();
  return it.layers[it.layers.length - 1] || null;
}

/* --------------------------------------------------------------------------
   Toasts + confirm
   -------------------------------------------------------------------------- */

/**
 * Transient message. NEVER alert() — a modal browser dialog blocks ComfyUI's
 * canvas and its render loop.
 * @param {string} message
 * @param {{kind?: "info"|"success"|"error"|"warn", ms?: number}} [opts]
 */
export function toast(message, opts = {}) {
  const it = inst();
  const kind = opts.kind || "info";
  const ms = typeof opts.ms === "number" ? opts.ms : 4000;
  if (!it.built || !it.els.toasts) {
    console.info(`${NS} ${kind}: ${message}`);
    return null;
  }
  const el = h(
    "div",
    {
      className: "pl-toast" + (kind === "error" ? " is-error" : kind === "warn" ? " is-warn" : ""),
      role: "status",
      "aria-live": kind === "error" ? "assertive" : "polite",
    },
    String(message == null ? "" : message)
  );
  it.els.toasts.appendChild(el);
  const kill = () => {
    if (!el.parentNode) return;
    el.classList.add("is-out");
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  };
  if (ms > 0) setTimeout(kill, ms);
  el.addEventListener("click", kill);
  return el;
}

/**
 * Basic confirm dialog rendered into the layer stack.
 *
 * Deliberately self-contained: `dialogs.js` will offer richer flows, but the
 * modal must never depend on a module that may not be there.
 *
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  const it = inst();
  if (!it.built) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      popLayer(handle);
      resolve(!!val);
    };
    const body = h("div", { className: "pl-dialog-body" });
    const lines = String(message == null ? "" : message).split("\n");
    for (const line of lines) body.appendChild(h("div", null, line));

    const el = h(
      "div",
      { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { className: "pl-dialog-title" }, title),
      body,
      h(
        "div",
        { className: "pl-dialog-acts" },
        h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => finish(false) }, cancelLabel),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm " + (danger ? "pl-btn-danger" : "pl-btn-primary"),
            type: "button",
            onclick: () => finish(true),
          },
          confirmLabel
        )
      )
    );
    const handle = pushLayer({ el, closeOnOutside: false, onClose: () => finish(false) });
    if (!handle) {
      resolve(false);
      return;
    }
  });
}

/* --------------------------------------------------------------------------
   Target node
   -------------------------------------------------------------------------- */

/** Every PromptLibrarian node currently in the graph. Never cached. */
function librarianNodes() {
  const app = hostApp();
  const graph = app && app.graph;
  if (!graph) return [];
  let nodes = null;
  if (Array.isArray(graph._nodes)) nodes = graph._nodes;
  else if (Array.isArray(graph.nodes)) nodes = graph.nodes;
  else if (typeof graph.findNodesByType === "function") {
    try {
      nodes = graph.findNodesByType(NODE_CLASS);
    } catch (_) {
      nodes = null;
    }
  }
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n) => n && (n.comfyClass === NODE_CLASS || n.type === NODE_CLASS));
}

/**
 * Resolve the target node BY ID, every single time.
 *
 * Holding a node reference is the bug this avoids: the user deletes the node,
 * or loads another workflow, and we keep a detached object that still answers
 * `.widgets` — so `Load into node` silently writes into a node that is not on
 * the canvas any more.
 */
function resolveTarget() {
  const it = inst();
  const id = it.state.targetNodeId;
  if (id == null) return null;
  const app = hostApp();
  const graph = app && app.graph;
  if (!graph) return null;
  let node = null;
  if (typeof graph.getNodeById === "function") {
    try {
      node = graph.getNodeById(id);
    } catch (_) {
      node = null;
    }
  }
  if (!node) node = librarianNodes().find((n) => String(n.id) === String(id)) || null;
  if (!node) return null;
  if (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS) return null;
  return node;
}

export function getTargetNodeId() {
  return inst().state.targetNodeId;
}

function nodeLabel(node) {
  if (!node) return "";
  const title = node.title || "Prompt Librarian";
  return `#${node.id} ${title}`;
}

/** Repaint the header chip and the `targetOk` flag. */
function refreshTarget() {
  const it = inst();
  if (!it.built) return;
  const node = resolveTarget();
  const any = librarianNodes();
  const ok = !!node;
  if (it.state.targetOk !== ok) setState({ targetOk: ok });
  else it.state.targetOk = ok;

  const chip = it.els.target;
  if (!chip) return;
  cls(chip, "is-stale", !ok);
  const text = ok
    ? `${ARROW} ${nodeLabel(node)} ${CARET}`
    : any.length
    ? `${ARROW} pick a node ${CARET}`
    : `${ARROW} no Librarian node ${CARET}`;
  const span = chip.firstChild;
  if (span) span.textContent = text;
  chip.title = ok
    ? "Load into node sends the prompt to this node. Click to target a different one."
    : any.length
    ? "The targeted node is gone. Click to pick another; everything else still works."
    : "add a Prompt Librarian node first";
  chip.disabled = false;
}

function openTargetPicker() {
  const it = inst();
  const nodes = librarianNodes();
  const list = h("div", { className: "pl-popover", role: "listbox", "aria-label": "Target node" });
  if (!nodes.length) {
    list.appendChild(h("div", { className: "pl-opt", "aria-disabled": "true" }, "add a Prompt Librarian node first"));
  }
  for (const node of nodes) {
    const selected = String(node.id) === String(it.state.targetNodeId);
    list.appendChild(
      h(
        "button",
        {
          className: "pl-opt",
          type: "button",
          role: "option",
          "aria-selected": selected ? "true" : "false",
          onclick: () => {
            setState({ targetNodeId: node.id });
            refreshTarget();
            popLayer(handle);
          },
        },
        nodeLabel(node)
      )
    );
  }
  // Positioned from viewport coordinates. This works only because .pl-layers
  // is a sibling of .pl-card — .pl-card has `contain: layout paint`, which
  // makes it a containing block for position:fixed and would offset us.
  const rect = it.els.target.getBoundingClientRect();
  list.style.top = `${Math.round(rect.bottom + 6)}px`;
  list.style.left = `${Math.round(rect.left)}px`;
  const handle = pushLayer({ el: list, closeOnOutside: true });
}

/**
 * Push a record into the target node's widgets.
 *
 * Order matters: assign `.value` FIRST, then call the widget callback. The old
 * node (web/prompt_library.js) documents that ComfyUI's own combo callback
 * "resets widget state and fights our async update" — callbacks are not
 * trustworthy, so the value is set before one can run and every call is
 * wrapped.
 *
 * @param {object} record needs at least {body}; {id} enables usage tracking
 * @returns {{ok: boolean, reason?: string}}
 */
export function loadIntoNode(record) {
  if (!record) return { ok: false, reason: "no_record" };
  const node = resolveTarget();
  if (!node) {
    refreshTarget();
    return { ok: false, reason: "stale_target" };
  }
  const widgets = Array.isArray(node.widgets) ? node.widgets : [];
  const textW = widgets.find((w) => w && w.name === "text");
  const idW = widgets.find((w) => w && w.name === "prompt_id");
  if (!textW) return { ok: false, reason: "no_text_widget" };

  const body = record.body == null ? "" : String(record.body);
  const id = record.id == null ? "" : String(record.id);

  textW.value = body;
  if (idW) idW.value = id;

  for (const [w, val] of [
    [textW, body],
    [idW, id],
  ]) {
    if (!w || typeof w.callback !== "function") continue;
    try {
      w.callback(val, hostApp() && hostApp().canvas, node);
    } catch (err) {
      warnOnce("widget-callback", "a widget callback threw while loading a prompt", err);
    }
  }

  try {
    if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  } catch (_) {
    /* ignore */
  }
  try {
    const canvas = hostApp() && hostApp().canvas;
    if (canvas && typeof canvas.selectNode === "function") canvas.selectNode(node, false);
  } catch (_) {
    /* purely cosmetic */
  }

  if (id) {
    // Fire and forget: a usage-tracking failure must never block the load.
    Promise.resolve()
      .then(() => API.usage(id, { body }))
      .catch(() => {});
    invalidateMeta([id]);
  }
  return { ok: true };
}

/* --------------------------------------------------------------------------
   Draft persistence
   -------------------------------------------------------------------------- */

function draftKey(id) {
  return DRAFT_PREFIX + (id || "new");
}

function saveDraft(id, buffer) {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(draftKey(id), JSON.stringify(buffer));
  } catch (_) {
    /* quota or privacy mode — drafts are a convenience, never a requirement */
  }
}

function loadDraft(id) {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(draftKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function clearDraft(id) {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(draftKey(id));
  } catch (_) {
    /* ignore */
  }
}

/* --------------------------------------------------------------------------
   Shell construction
   -------------------------------------------------------------------------- */

function buildShell() {
  const it = inst();
  if (it.built) return it;

  const els = it.els;

  const backdrop = h("div", { className: "pl-backdrop" });

  const target = h(
    "button",
    {
      className: "pl-target",
      type: "button",
      "aria-haspopup": "listbox",
      onclick: () => openTargetPicker(),
    },
    h("span", null, `${ARROW} ${CARET}`)
  );

  const seg = h(
    "div",
    { className: "pl-seg", role: "tablist", "aria-label": "Pane", style: { flex: "1 1 100%", order: "6" } },
    h(
      "button",
      {
        className: "pl-seg-tab",
        type: "button",
        role: "tab",
        "aria-selected": "true",
        onclick: () => setPane("browse"),
      },
      "Browse"
    ),
    h(
      "button",
      {
        className: "pl-seg-tab",
        type: "button",
        role: "tab",
        "aria-selected": "false",
        onclick: () => setPane("edit"),
      },
      "Edit"
    )
  );

  const sub = h("div", { className: "pl-sub" }, "");

  const head = h(
    "div",
    { className: "pl-head" },
    h("div", { className: "pl-dot" }),
    h("div", { className: "pl-title" }, "Prompt Library"),
    sub,
    h("div", { className: "pl-spacer" }),
    target,
    h(
      "button",
      {
        className: "pl-close",
        type: "button",
        "aria-label": "Close",
        title: "Close (Esc)",
        onclick: () => attemptClose(),
      },
      TIMES
    ),
    seg
  );

  const rail = h("div", { className: "pl-rail" });
  const inspect = h("div", { className: "pl-inspect" });
  const body = h("div", { className: "pl-body", dataset: { pane: "browse" } }, rail, inspect);

  const foot = h(
    "div",
    { className: "pl-foot" },
    h("span", { className: "pl-pill" }, "comfyui-prompt-library"),
    h("span", null, `// output: text ${ARROW}`)
  );

  const card = h("div", { className: "pl-card", role: "dialog", "aria-modal": "true", "aria-label": "Prompt Library" }, head, body, foot);

  // .pl-layers and .pl-toasts are children of .pl-root and SIBLINGS of
  // .pl-card. That is not cosmetic: .pl-card sets `contain: layout paint`,
  // which makes it a containing block for `position: fixed` descendants — a
  // popover positioned from getBoundingClientRect would be offset by the
  // card's origin. See the note on .pl-card in librarian.css.
  const layers = h("div", { className: "pl-layers" });
  const toasts = h("div", { className: "pl-toasts" });

  const root = h(
    "div",
    { className: "pl-root", hidden: true, dataset: { w: "wide" } },
    backdrop,
    card,
    layers,
    toasts
  );

  Object.assign(els, { backdrop, card, head, sub, target, seg, body, rail, inspect, foot, layers, toasts });
  it.root = root;
  it.built = true;

  document.body.appendChild(root);
  return it;
}

function setPane(which) {
  const it = inst();
  if (!it.built) return;
  it.els.body.dataset.pane = which;
  const tabs = it.els.seg.querySelectorAll('[role="tab"]');
  if (tabs[0]) tabs[0].setAttribute("aria-selected", which === "browse" ? "true" : "false");
  if (tabs[1]) tabs[1].setAttribute("aria-selected", which === "edit" ? "true" : "false");
}

/* --------------------------------------------------------------------------
   Shell wiring — one-time listeners
   -------------------------------------------------------------------------- */

function wireShell() {
  const it = inst();
  const root = it.root;

  // ---- Escape + Tab, through the key bus (see the KEY ISOLATION block) ----
  onKey(root, "keydown", (e) => {
    if (e.key === "Escape" || e.key === "Esc") {
      // Escape is the ONE key we are allowed to preventDefault.
      e.preventDefault();
      if (it.layers.length) popLayer();
      else attemptClose();
      return;
    }
    if (e.key === "Tab") handleTab(e);
  });

  // ---- Click-outside ------------------------------------------------------
  // Both pointerdown AND pointerup must land on the backdrop. Without that a
  // drag-select started inside the list and released over the backdrop closes
  // the modal and throws away the edit.
  root.addEventListener("pointerdown", (e) => {
    const top = topLayer();
    if (top && top.closeOnOutside && top.el && !top.el.contains(e.target)) {
      popLayer(top);
      return;
    }
    it.backdropDown = e.target === it.els.backdrop;
  });
  root.addEventListener("pointerup", (e) => {
    const down = it.backdropDown;
    it.backdropDown = false;
    if (!down || e.target !== it.els.backdrop) return;
    if (it.layers.length) return;
    attemptClose();
  });

}

/* --------------------------------------------------------------------------
   Responsive — installed per open, torn down on close
   --------------------------------------------------------------------------
   NOT part of wireShell(): closeModal() disconnects the observer and drains
   the teardown list, so anything installed once at build time would be dead
   after the first close.
   -------------------------------------------------------------------------- */

function installResponsive() {
  const it = inst();
  const root = it.root;

  const applyWidth = (w) => {
    const mode = w < NARROW_AT ? "narrow" : "wide";
    if (root.dataset.w === mode) return;
    root.dataset.w = mode;
    // The contract asks for it on the card; the stylesheet keys off the root.
    if (it.els.card) it.els.card.dataset.w = mode;
    if (mode === "wide") it.els.body.dataset.pane = "browse";
  };
  // The ROOT is measured, not the card: narrow mode removes the root's 24px
  // padding, which widens the card — measuring the card would oscillate
  // across the threshold. The root is `position: fixed; inset: 0`, so its
  // width is the viewport's and is unaffected by the mode we set.
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = (entry.contentRect && entry.contentRect.width) || root.clientWidth || 0;
        applyWidth(w);
      }
    });
    try {
      ro.observe(root);
      it.ro = ro;
    } catch (err) {
      warnOnce("resize-observer", "ResizeObserver.observe failed; falling back to window resize", err);
      it.ro = null;
    }
  }
  if (!it.ro) {
    const onResize = () => applyWidth(root.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1200));
    if (typeof window !== "undefined") window.addEventListener("resize", onResize);
    it.teardown.push(() => {
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
    });
    onResize();
  } else {
    applyWidth(root.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1200));
  }
}

/* --------------------------------------------------------------------------
   Dirty / close
   -------------------------------------------------------------------------- */

function isDirty() {
  const it = inst();
  const fn = it.ctx && it.ctx.isDirty;
  if (typeof fn !== "function") return false; // inspector not mounted
  try {
    return !!fn();
  } catch (err) {
    console.error(`${NS} isDirty threw`, err);
    return false;
  }
}

/** Inline `Discard unsaved edits?` bar — never window.confirm(). */
function showDirtyBar() {
  const it = inst();
  if (it.dirtyBar) return;
  const bar = h(
    "div",
    {
      className: "pl-dirty",
      role: "status",
      style: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        marginLeft: "auto",
        color: "var(--pl-warn)",
      },
    },
    h("span", null, "Discard unsaved edits?"),
    h(
      "button",
      {
        className: "pl-btn pl-btn-sm pl-btn-danger",
        type: "button",
        onclick: () => {
          hideDirtyBar();
          closeModal();
        },
      },
      "Discard"
    ),
    h(
      "button",
      { className: "pl-btn pl-btn-sm", type: "button", onclick: () => hideDirtyBar() },
      "Keep editing"
    )
  );
  it.dirtyBar = bar;
  it.els.foot.appendChild(bar);
  const btn = focusables(bar)[1];
  if (btn) {
    try {
      btn.focus();
    } catch (_) {
      /* ignore */
    }
  }
}

function hideDirtyBar() {
  const it = inst();
  if (!it.dirtyBar) return;
  if (it.dirtyBar.parentNode) it.dirtyBar.parentNode.removeChild(it.dirtyBar);
  it.dirtyBar = null;
}

function attemptClose() {
  if (isDirty()) {
    showDirtyBar();
    return false;
  }
  closeModal();
  return true;
}

/* --------------------------------------------------------------------------
   Mounting the panes
   -------------------------------------------------------------------------- */

function placeholder(el, text) {
  clear(el);
  el.appendChild(h("div", { className: "pl-list-empty" }, text));
}

async function mountPanes() {
  const it = inst();

  if (!it.mounted.list) {
    try {
      const mod = await import("./list.js");
      if (typeof mod.mountList !== "function") throw new Error("mountList missing");
      mod.mountList(it.els.rail, ctx());
      it.mounted.list = true;
    } catch (err) {
      warnOnce("list-missing", "web/pl/list.js failed to mount", err);
      placeholder(it.els.rail, "the browser rail is unavailable");
    }
  }

  if (!it.mounted.inspector) {
    try {
      const mod = await import("./inspector.js");
      if (typeof mod.mountInspector !== "function") throw new Error("mountInspector missing");
      mod.mountInspector(it.els.inspect, ctx());
      it.mounted.inspector = true;
    } catch (err) {
      warnOnce(
        "inspector-missing",
        "web/pl/inspector.js is not available (the editor pane is a placeholder)",
        err && err.message
      );
      placeholder(it.els.inspect, "the prompt inspector is not available yet");
    }
  }
}

/* --------------------------------------------------------------------------
   Data
   -------------------------------------------------------------------------- */

function normaliseTags(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => {
      if (typeof t === "string") return { name: t, count: 0 };
      if (!t || typeof t !== "object") return null;
      // The store answers {tag, count}; the state shape uses {name, count}.
      return { name: String(t.name != null ? t.name : t.tag || ""), count: Number(t.count) || 0 };
    })
    .filter((t) => t && t.name);
}

function normaliseCategories(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((c) =>
      typeof c === "string"
        ? { name: c, count: 0 }
        : c && typeof c === "object"
        ? { name: String(c.name || ""), count: Number(c.count) || 0 }
        : null
    )
    .filter((c) => c && c.name);
}

function paintHeader() {
  const it = inst();
  if (!it.built) return;
  const st = it.state;
  const prompts = `${fmtInt(st.total)} prompt${st.total === 1 ? "" : "s"}`;
  const cats = `${fmtInt(st.catCount)} categor${st.catCount === 1 ? "y" : "ies"}`;
  it.els.sub.textContent = `// ${prompts} ${MIDDOT} ${cats}`;
}

async function loadTaxonomy() {
  const res = await lanes.taxonomy((signal) => API.taxonomy(signal));
  if (res === ABORTED || !res) return;
  const categories = normaliseCategories(res.categories);
  setState({
    categories,
    tags: normaliseTags(res.tags),
    catCount: categories.length,
    total: Number(res.total) || 0,
    rev: Number(res.rev) || inst().state.rev,
  });
  paintHeader();
}

/** Re-run the search and reload the taxonomy. */
export async function refreshAll() {
  const it = inst();
  await Promise.all([
    loadTaxonomy().catch((err) => reportError(err, "taxonomy")),
    Promise.resolve()
      .then(() => it.ctx && it.ctx.list && it.ctx.list.refresh && it.ctx.list.refresh({ reset: true }))
      .catch((err) => reportError(err, "search")),
  ]);
}

function reportError(err, what) {
  if (err === ABORTED) return;
  const msg =
    err instanceof ApiError
      ? err.code === "not_json"
        ? "the librarian backend is not responding (is the extension loaded?)"
        : err.message
      : (err && err.message) || String(err);
  console.error(`${NS} ${what} failed`, err);
  toast(`${what}: ${msg}`, { kind: "error", ms: 6000 });
}

/* --------------------------------------------------------------------------
   ctx() — the object handed to mountList / mountInspector
   --------------------------------------------------------------------------
   Always the SAME object, so a pane can attach hooks to it:

     ctx.isDirty       = () => boolean        (inspector — drives close/discard)
     ctx.list          = {refresh, ...}       (list.js registers itself)
     ctx.inspector     = {select, ...}        (inspector registers itself)
     ctx.onSelectPrompt= (id) => void         (alternative to ctx.inspector)
   -------------------------------------------------------------------------- */

export function ctx() {
  const it = inst();
  if (it.ctx) return it.ctx;
  it.ctx = {
    // dom.js helpers, handed over so a pane never has to guess the path back
    // to them (inspector.js reads ctx.dom).
    dom,

    // transport
    API,
    lanes,
    ABORTED,
    ApiError,
    caps,
    invalidateMeta,

    // state
    getState,
    setState,
    subscribe,
    get state() {
      return inst().state;
    },

    // chrome
    toast,
    confirmDialog,
    pushLayer,
    popLayer,
    topLayer,
    onKey,
    closeModal,
    attemptClose,
    refreshAll,
    reportError,

    // node
    loadIntoNode,
    getTargetNodeId,
    targetNode: resolveTarget,
    librarianNodes,
    refreshTarget,

    // drafts
    saveDraft,
    loadDraft,
    clearDraft,

    // panes register themselves here
    list: null,
    inspector: null,
    /** Push any debounce() from dom.js here; closeModal() cancels them all. */
    debounces: [],

    /**
     * Focus a record. Called by list.js on row activation; delegates to the
     * inspector, and is a safe no-op when the inspector is not mounted.
     */
    selectPrompt(id, opts) {
      setState({ currentId: id == null ? null : String(id) });
      const c = inst().ctx;
      const fn =
        (c.inspector && typeof c.inspector.select === "function" && c.inspector.select) ||
        (typeof c.onSelectPrompt === "function" && c.onSelectPrompt) ||
        null;
      if (!fn) return false;
      try {
        fn(id, opts || {});
      } catch (err) {
        console.error(`${NS} selectPrompt failed`, err);
      }
      return true;
    },

    /** Elements the panes may need (the rail/inspect roots are handed in). */
    els: it.els,
    get root() {
      return inst().root;
    },
    get app() {
      return hostApp();
    },
  };
  return it.ctx;
}

/* --------------------------------------------------------------------------
   open / close
   -------------------------------------------------------------------------- */

/**
 * Open the librarian. Idempotent: a second call on an open modal just
 * re-targets and refreshes.
 * @param {{targetNodeId?: any}} [opts]
 */
export async function openModal(opts = {}) {
  if (typeof document === "undefined") return null;
  ensureStyles();
  const it = buildShell();

  if (!it.wired) {
    wireShell();
    it.wired = true;
  }

  // Target: the node that asked, else whatever we had, else the first one.
  let targetId = opts.targetNodeId != null ? opts.targetNodeId : it.state.targetNodeId;
  if (targetId == null) {
    const first = librarianNodes()[0];
    targetId = first ? first.id : null;
  }
  setState({ targetNodeId: targetId }, { silent: true });

  if (!it.open) {
    it.previouslyFocused = document.activeElement;
    it.root.hidden = false;
    it.open = true;
    installKeyGuards();
    installResponsive();
    it.heartbeat = setInterval(refreshTarget, HEARTBEAT_MS);
    it.teardown.push(() => {
      clearInterval(it.heartbeat);
      it.heartbeat = 0;
    });
  }

  refreshTarget();
  paintHeader();

  // Capabilities first — panes read ctx.caps while mounting.
  try {
    const ping = await API.ping();
    setState({ caps: { ...caps }, rev: (ping && Number(ping.rev)) || it.state.rev });
  } catch (err) {
    warnOnce("ping-failed", "ping failed; assuming every capability is present", err && err.message);
  }

  await loadTaxonomy().catch((err) => reportError(err, "taxonomy"));
  await mountPanes();

  // First paint of the list happens after mount so the source exists.
  try {
    if (it.ctx && it.ctx.list && typeof it.ctx.list.refresh === "function") {
      await it.ctx.list.refresh({ reset: true });
    }
  } catch (err) {
    reportError(err, "search");
  }

  const focusTarget = it.root.querySelector(".pl-search-in") || it.els.card;
  try {
    focusTarget.focus();
  } catch (_) {
    /* ignore */
  }
  return it.root;
}

/**
 * Close and dismantle everything that could outlive the modal: both key
 * layers, the ResizeObserver, the heartbeat, every debounce, every lane, the
 * layer stack. The DOM itself is kept and hidden — rebuilding it on every open
 * costs a frame for nothing.
 */
export function closeModal() {
  const bag = singletonBag();
  const it = bag.modal;
  if (!it || !it.built || !it.open) return;

  it.open = false;
  hideDirtyBar();

  while (it.layers.length) popLayer(it.layers[it.layers.length - 1]);

  for (const fn of it.teardown.splice(0)) {
    try {
      fn();
    } catch (err) {
      console.error(`${NS} teardown step failed`, err);
    }
  }

  if (it.ro) {
    try {
      it.ro.disconnect();
    } catch (_) {
      /* ignore */
    }
    it.ro = null;
  }

  // Panes register their debounces here so one loop cancels them all.
  const c = it.ctx;
  if (c && Array.isArray(c.debounces)) {
    for (const d of c.debounces) {
      try {
        if (d && typeof d.cancel === "function") d.cancel();
      } catch (_) {
        /* ignore */
      }
    }
  }

  cancelAllLanes();

  it.root.hidden = true;

  const back = it.previouslyFocused;
  it.previouslyFocused = null;
  if (back && typeof back.focus === "function") {
    try {
      back.focus();
    } catch (_) {
      /* ignore */
    }
  }
}
