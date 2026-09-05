/* Window capture blocks ComfyUI shortcuts before document/canvas listeners.
 * A root bubble guard provides a fallback. Preserve native text entry, IME,
 * and clipboard defaults; preventDefault only for owned shortcuts.
 *
 * Native key listeners inside the modal cannot receive captured events. Use
 * ctx.onKey for ordered delivery of the original event, or pl:keydown/keyup/
 * keypress mirrors with detail.event. Mirror cancellation forwards to the original.
 *
 * Remove guards on close using the same capture flags, or page shortcuts
 * remain blocked. Ctrl/Cmd+S is owned only while focus is inside the modal.
 */

import { NS } from "../../shared/ns.js";
import { inst } from "../state.js";

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

function deliverKey(e) {
  const it = inst();
  const root = it.root;
  if (!root) return;

  const path = [];
  for (let n = e.target; n; n = n.parentNode) {
    path.push(n);
    if (n === root) break;
  }
  if (path[path.length - 1] !== root) return;

  let stopped = false;
  let immediate = false;

  // Shadow propagation methods for bus delivery; keep preventDefault on the
  // original event so native defaults can still be cancelled by handlers.
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
    if (!t || typeof root.contains !== "function" || !root.contains(t)) return;
    // Only suppress Save Page for chords focused inside the Librarian.
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


