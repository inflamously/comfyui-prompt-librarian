/* ==========================================================================
   KEY ISOLATION — THE TOP HAZARD IN THIS PACK. READ BEFORE EDITING.
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only; the guards are installed by
   `installKeyGuards()`, which openModal() calls, and removed on close.

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
     never learns a key was pressed. Ctrl/Cmd+S follows the same ownership
     boundary: inside the Librarian it saves the prompt; outside the root the
     event is untouched. Once the modal closes, ComfyUI keeps its workflow-save
     shortcut (close.js also clears ComfyUI's DOM-based modal gate).

   Layer B — root-level BUBBLE stops, for the (many) handlers bound on body or
     the canvas in the bubble phase. Defence in depth: if Layer A ever fails to
     install, this still catches everything that bubbles.

   `stopPropagation` ONLY for ordinary keys — NEVER `preventDefault` on them.
   Text entry, IME composition and clipboard actions are DEFAULT ACTIONS, not
   listeners; preventing them breaks typing outright. Ctrl/Cmd+S is narrowly
   prevented to suppress the browser's Save Page dialog. Escape is prevented
   by its handler in modal/shell.js.

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

import { NS } from "../shared/ns.js";
import { inst } from "./state.js";

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

function isSaveChord(e) {
  return (
    e.type === "keydown" &&
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    String(e.key).toLowerCase() === "s"
  );
}

/**
 * Register a key handler that survives the capture guard.
 * @returns {() => void} unregister
 */
export function onKey(el, type, fn, opts = {}) {
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

export function installKeyGuards() {
  const it = inst();
  const root = it.root;
  if (!root || typeof window === "undefined") return;

  // ---- Layer A: window CAPTURE ------------------------------------------
  const guard = (e) => {
    const t = e.target;
    // `contains` covers text nodes and the root itself; a target of `window`
    // or `document` (some synthetic events) is correctly excluded.
    if (!t || typeof root.contains !== "function" || !root.contains(t)) return;
    // Event targets track keyboard focus. A chord from inside the root belongs
    // solely to the Librarian; a chord outside never enters this branch and is
    // left untouched. Suppress Save Page only for the chord we own.
    if (isSaveChord(e)) e.preventDefault();
    e.stopImmediatePropagation(); // never preventDefault for ordinary keys
    deliverKey(e);
  };
  for (const type of KEY_TYPES) window.addEventListener(type, guard, true);
  it.teardown.push(() => {
    // IDENTICAL capture flag — removeEventListener will not match otherwise.
    for (const type of KEY_TYPES) window.removeEventListener(type, guard, true);
  });

  // ---- Layer B: root-level bubble stops ----------------------------------
  const stop = (e) => {
    // Defence in depth if the window guard was unavailable.
    if (isSaveChord(e)) e.preventDefault();
    e.stopPropagation();
  }; // never stopImmediatePropagation:
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

export function focusables(scope) {
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

export function handleTab(e) {
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
