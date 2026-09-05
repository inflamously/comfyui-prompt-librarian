/* Keeps a PromptLibrarian node's `text` widget in sync with the librarian UI.
 *
 * This is the only module that touches a widget's internals. It has three jobs:
 *
 *   READ   readNodeText(node)          -> {body, id} currently on the node
 *   WRITE  writeNodeText(node, values) -> put a body and/or prompt_id onto the node
 *   WATCH  watchNodeText(node, fn)     -> call fn whenever the body changes on
 *                                         the canvas (typing, paste, other code)
 *          pollNodeText(node)          -> manual check, driven by the modal heartbeat
 *
 * Why watching needs three mechanisms: ComfyUI frontends store the text
 * differently (accessors over inputEl, DOM wrappers, Vue-backed values that
 * recreate their element), and we cannot tell which one we are on. So each
 * mechanism is installed independently and any of them may be unavailable:
 *
 *   1. element events    `input`/`change` listeners on the backing <textarea>
 *   2. value intercept   wrap `widget.value` so programmatic sets are seen too
 *   3. polling           pollNodeText(), which also re-installs 1 and 2 when
 *                        the frontend re-renders the widget
 *
 * All three report through notify(). `lastSeen` (the last body written or
 * observed) drops echoes, so our own writes and repeated observations of the
 * same value never reach the subscribers.
 */

import { warnOnce } from "../shared/singleton.js";
import { ID_WIDGET, TEXT_WIDGET, findWidget } from "./widgets.js";

export { ID_WIDGET, TEXT_WIDGET, findWidget };

/** node -> watch state. One per node, shared by every subscriber. */
const WATCHES = new WeakMap();


/* ---- Widget access -------------------------------------------------------- */

/** Return the backing textarea, including wrapped DOM widgets, or null for
 * frontends without one.
 */
export function widgetElement(w) {
  if (!w) return null;
  try {
    const cand = [w.inputEl, w.element, w.el, w.domElement];
    for (const c of cand) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.value === "string" && typeof c.addEventListener === "function") return c;
      if (typeof c.querySelector === "function") {
        const inner = c.querySelector("textarea, input");
        if (inner) return inner;
      }
    }
  } catch (_) {
    /* an exotic widget that throws on property access is simply elementless */
  }
  return null;
}

/** Programmatic .value assignment does not fire input; notify mirror/autosize
 * listeners explicitly. Keep this helper independent of pickers/.
 */
function dispatchInput(el) {
  if (!el || typeof el.dispatchEvent !== "function") return;
  try {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (_) {
    try {
      const ev = document.createEvent("Event");
      ev.initEvent("input", true, false);
      el.dispatchEvent(ev);
    } catch (__) {
      /* nothing more we can do; the value is still set */
    }
  }
}

function str(v) {
  return v == null ? "" : String(v);
}

/** The textarea may be ahead of widget.value until blur. Keep both sources
 * separate; null means absent, while an empty string is a valid value.
 *
 * @returns {{el: string|null, widget: string|null}}
 */
function rawValues(textW) {
  const el = widgetElement(textW);
  return {
    el: el && typeof el.value === "string" ? str(el.value) : null,
    widget: textW ? str(textW.value) : null,
  };
}


/* ---- READ ----------------------------------------------------------------- */

/** Prefer the backing element because some frontends sync widget.value only on blur.
 *
 * @returns {{body: string, id: string} | null} null when the widgets are not
 *   wired yet (nodeCreated fires before ComfyUI applies serialized values).
 */
export function readNodeText(node) {
  const textW = findWidget(node, TEXT_WIDGET);
  if (!textW) return null;
  const idW = findWidget(node, ID_WIDGET);
  const raw = rawValues(textW);
  return {
    body: raw.el !== null ? raw.el : str(raw.widget),
    id: str(idW ? idW.value : ""),
  };
}


/* ---- WRITE ---------------------------------------------------------------- */

/** The single write path onto the node; the live link and explicit loads both
 * use it. Assign values before invoking frontend callbacks, which may reset
 * widget state or throw.
 *
 * @param {object} node
 * @param {{body?: string, id?: string}} values `id` is only written when the
 *   property is present — passing {body} alone leaves the link untouched.
 * @param {{canvas?: object}} [opts]
 * @returns {{ok: boolean, reason?: string}}
 */
export function writeNodeText(node, values, opts = {}) {
  if (!node) return { ok: false, reason: "stale_target" };
  const textW = findWidget(node, TEXT_WIDGET);
  if (!textW) return { ok: false, reason: "no_text_widget" };
  const idW = findWidget(node, ID_WIDGET);

  const hasBody = values && Object.prototype.hasOwnProperty.call(values, "body");
  const hasId = values && Object.prototype.hasOwnProperty.call(values, "id");
  const body = hasBody ? str(values.body) : null;
  const id = hasId ? str(values.id) : null;

  // Suppress our own watchers for the duration of the write. `lastSeen` is
  // the real echo guard; this just avoids pointless work in mechanisms 1 and 2.
  const st = WATCHES.get(node);
  const prevWriting = st ? st.writing : false;
  if (st) {
    st.writing = true;
    if (hasBody) st.lastSeen = body;
  }

  try {
    const written = [];

    if (hasBody) {
      try {
        textW.value = body;
      } catch (err) {
        warnOnce("write-text-value", "could not set the text widget value", err);
      }
      // The widget value and its element can disagree — assigning one does not
      // always propagate to the other. Set both, then announce it.
      const el = widgetElement(textW);
      if (el && el.value !== body) {
        try {
          el.value = body;
          dispatchInput(el);
        } catch (err) {
          warnOnce("write-text-el", "could not set the text widget element", err);
        }
      }
      written.push([textW, body]);
    }

    if (hasId && idW) {
      try {
        idW.value = id;
      } catch (err) {
        warnOnce("write-id-value", "could not set the prompt_id widget", err);
      }
      written.push([idW, id]);
    }

    const canvas = opts.canvas || null;
    for (const [w, val] of written) {
      if (!w || typeof w.callback !== "function") continue;
      try {
        w.callback(val, canvas, node);
      } catch (err) {
        warnOnce("widget-callback", "a widget callback threw while writing the node", err);
      }
    }

    try {
      if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
    } catch (_) {
    }
  } finally {
    if (st) st.writing = prevWriting;
  }

  return { ok: true };
}


/* ---- WATCH ---------------------------------------------------------------- */

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
