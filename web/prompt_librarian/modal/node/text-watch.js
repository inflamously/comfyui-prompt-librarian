/* Watching a node's body (see text-sync.js for the three mechanisms). One
 * watch state per node, shared by every subscriber; writeNodeText() reads it
 * through watchStateOf() to suppress echoes of its own writes.
 */

import { warnOnce } from "../../shared/singleton.js";
import { rawValues, readNodeText, str, widgetElement } from "./text-access.js";
import { TEXT_WIDGET, findWidget } from "./widgets.js";

/** node -> watch state. One per node, shared by every subscriber. */
const WATCHES = new WeakMap();

/** The node's watch state, or undefined when nobody watches it. */
export function watchStateOf(node) {
  return WATCHES.get(node);
}

/** Subscribe to body changes on the node. The first subscriber installs the
 * hooks; later ones (the node card and the modal both watch) reuse them, even
 * across cache-busted module instances. The last unsubscribe removes them.
 *
 * @param {object} node
 * @param {(body: string, node: object) => void} onChange called only when the
 *   value actually differs from the last one we wrote or observed
 * @returns {() => void} unwatch — safe to call more than once
 */
export function watchNodeText(node, onChange) {
  if (!node || typeof onChange !== "function") return () => {};

  const existing = WATCHES.get(node);
  if (existing) {
    existing.handlers.add(onChange);
    return () => {
      existing.handlers.delete(onChange);
      if (!existing.handlers.size) unwatchAll(node);
    };
  }

  const st = {
    node,
    handlers: new Set([onChange]),
    lastSeen: null,
    writing: false,
    widget: null,
    el: null,
    cleanups: [],
    detachElement: null, // mechanism 1's own cleanup, so a re-rendered element can swap
    cannotIntercept: false, // mechanism 2 is impossible here; stop retrying it
  };
  WATCHES.set(node, st);

  const seed = readNodeText(node);
  st.lastSeen = seed ? seed.body : null;

  listenToElement(st);
  interceptValue(st);

  return () => {
    const cur = WATCHES.get(node);
    if (!cur) return;
    cur.handlers.delete(onChange);
    if (!cur.handlers.size) unwatchAll(node);
  };
}

/** Forward a new body to every subscriber, unless it is our own write or the
 * value has not actually changed.
 */
function notify(st, raw) {
  const body = str(raw);
  if (st.writing) return;
  if (st.lastSeen !== null && body === st.lastSeen) return;
  st.lastSeen = body;
  for (const fn of Array.from(st.handlers)) {
    try {
      fn(body, st.node);
    } catch (err) {
      warnOnce("bind-handler", "a node-text watcher threw", err);
    }
  }
}

/* ---- Mechanism 1: element events ------------------------------------------ */

function listenToElement(st) {
  const w = findWidget(st.node, TEXT_WIDGET);
  if (!w) return; // widgets not wired yet — pollNodeText() will come back around
  st.widget = w;
  const el = widgetElement(w);
  if (!el || typeof el.addEventListener !== "function") return;
  if (st.el === el) return; // already listening on exactly this element

  // A frontend that re-renders the widget hands us a NEW element; the old
  // listeners are then attached to a detached node and would never fire again.
  if (st.el && st.detachElement) {
    try {
      st.detachElement();
    } catch (_) {
      /* the old element is going away anyway */
    }
    const i = st.cleanups.indexOf(st.detachElement);
    if (i >= 0) st.cleanups.splice(i, 1);
    st.detachElement = null;
  }
  st.el = el;

  const handler = () => notify(st, el.value);
  try {
    // `input` covers typing; `change` covers paste-and-blur on frontends that
    // batch, and IME commits on some browsers.
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
    st.detachElement = () => {
      el.removeEventListener("input", handler);
      el.removeEventListener("change", handler);
    };
    st.cleanups.push(st.detachElement);
  } catch (err) {
    st.el = null;
    warnOnce("bind-layer-a", "could not listen on the text widget element", err);
  }
}

/* ---- Mechanism 2: `value` interception ------------------------------------ */

/** Delegate to the existing accessor, including inherited descriptors: replacing
 * it with a data property disconnects legacy widgets from their textarea.
 * Restore the original descriptor on unwatch.
 */
function interceptValue(st) {
  const w = st.widget || findWidget(st.node, TEXT_WIDGET);
  if (!w) return;
  st.widget = w;
  if (w.__plBound) return; // already intercepted, possibly by an earlier module instance

  let desc = null;
  let owner = w;
  try {
    for (let o = w; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, "value");
      if (d) {
        desc = d;
        owner = o;
        break;
      }
    }
  } catch (err) {
    st.cannotIntercept = true;
    warnOnce("bind-layer-b-desc", "could not inspect the text widget descriptor", err);
    return;
  }

  // Non-configurable means we cannot redefine it and cannot restore it either.
  if (desc && desc.configurable === false) {
    st.cannotIntercept = true;
    warnOnce(
      "bind-layer-b-frozen",
      "the text widget value is not configurable; live node edits fall back to polling"
    );
    return;
  }

  const own = owner === w;
  let backing = desc && !desc.get ? desc.value : undefined;
  const get = desc && desc.get ? () => desc.get.call(w) : () => backing;
  const set =
    desc && desc.set
      ? (v) => desc.set.call(w, v)
      : (v) => {
          backing = v;
        };

  try {
    Object.defineProperty(w, "value", {
      configurable: true,
      enumerable: desc ? desc.enumerable !== false : true,
      get,
      set(v) {
        set(v);
        notify(st, v);
      },
    });
    w.__plBound = true;
  } catch (err) {
    st.cannotIntercept = true;
    warnOnce("bind-layer-b", "could not intercept the text widget value", err);
    return;
  }

  st.cleanups.push(() => {
    try {
      delete w.__plBound;
      if (own && desc) Object.defineProperty(w, "value", desc);
      else {
        // The descriptor lived on the prototype (or there was none): drop our
        // own property and let the chain answer again. Read the current value
        // first so nothing is lost on the way out.
        const cur = get();
        delete w.value;
        if (!desc) w.value = cur;
      }
    } catch (err) {
      warnOnce("bind-restore", "could not restore the text widget value property", err);
    }
  });
}

/* ---- Mechanism 3: polling ------------------------------------------------- */

/** Called from the modal heartbeat. Catches changes mechanisms 1 and 2 missed,
 * and re-installs them for late-created or re-rendered widgets.
 */
export function pollNodeText(node) {
  const st = WATCHES.get(node);
  if (!st || st.writing) return;

  // Re-resolve elements every tick to catch late mounting and Vue replacements.
  listenToElement(st);
  if (st.widget && !st.widget.__plBound && !st.cannotIntercept) interceptValue(st);

  const textW = st.widget || findWidget(node, TEXT_WIDGET);
  if (!textW) return;
  const raw = rawValues(textW);

  if (st.lastSeen === null) {
    st.lastSeen = raw.el !== null ? raw.el : str(raw.widget);
    return;
  }

  // When present, the element wins: widget.value may remain stale until blur.
  const cur = raw.el !== null ? raw.el : raw.widget;
  if (cur !== null && cur !== st.lastSeen) notify(st, cur);
}

export function isWatched(node) {
  return !!node && WATCHES.has(node);
}

/** Remove every hook installed on the node and drop its subscribers. */
function unwatchAll(node) {
  const st = WATCHES.get(node);
  if (!st) return;
  WATCHES.delete(node);
  for (const fn of st.cleanups.splice(0)) {
    try {
      fn();
    } catch (err) {
      warnOnce("bind-teardown", "a node-text cleanup step threw", err);
    }
  }
  st.handlers.clear();
}
