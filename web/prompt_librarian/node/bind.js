/* ==========================================================================
   Prompt Librarian — node ⇄ panel binding
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports EVERY .js under WEB_DIRECTORY as an
   extension, so this file is loaded whether or not anything imports it.
   Exports only — no module-scope work, no listeners, no fetches.

   This module is the *whole* answer to "the panel and the node drift apart".
   It owns two things and nothing else:

     writeNodeText()  panel -> node
     bindNode()       node  -> panel

   THE CONSTRAINT THAT SHAPES EVERYTHING HERE
   ------------------------------------------
   We do not know which ComfyUI frontend generation we are running on, and we
   cannot find out. A multiline STRING widget has been, across versions:

     * a LiteGraph "customtext" widget whose `value` is an accessor defined
       over a detached `<textarea>` held at `widget.inputEl`;
     * a DOM widget whose element is at `widget.element`, sometimes the
       textarea itself and sometimes a wrapper containing one;
     * a Vue-backed widget where `value` is reactive and the element is
       recreated on re-render.

   So every hook below is feature-detected, individually wrapped, and
   individually optional. `bindNode` returns a working `unbind` even when every
   observation layer failed to install — the caller never has to care, and the
   panel can never throw because a frontend surprised us.

   THE ECHO PROBLEM
   ----------------
   Two-way binding loops unless something breaks the cycle. One mechanism does
   it for all three layers: `st.lastSeen`, the last value we either wrote or
   observed. Anything equal to it is dropped on sight, in BOTH directions.
   Re-entrancy flags alone would not be enough — layer C (polling) fires long
   after any flag has been cleared.
   ========================================================================== */

import { warnOnce } from "../shared/singleton.js";
import { ID_WIDGET, TEXT_WIDGET, findWidget } from "./widgets.js";

// Re-exported so a caller that already imports the binder does not need a
// second import for the two names it is about to pass around.
export { ID_WIDGET, TEXT_WIDGET, findWidget };

/** Per-node binding state, keyed off the node object itself. */
const BINDINGS = new WeakMap();

/* --------------------------------------------------------------------------
   Element lookup
   -------------------------------------------------------------------------- */

/**
 * The real `<textarea>` behind a multiline widget, if this frontend has one.
 *
 * Ordered most-specific first. `element` may be the textarea itself or a
 * wrapper around one, so it is checked both ways. Returns null on any frontend
 * that keeps no DOM element — which is a supported outcome, not a failure.
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

/**
 * Setting `.value` from JS does NOT fire `input` — the event only exists for
 * real user edits. Frontends that mirror, autosize or highlight the textarea
 * listen for it, so a programmatic write has to say so explicitly or the
 * on-canvas widget keeps painting stale text.
 *
 * Modelled on the identical helper in pickers/caret.js, which is scoped to
 * that feature; copying three lines beats coupling the binder to the pickers.
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

/* --------------------------------------------------------------------------
   Reading
   -------------------------------------------------------------------------- */

/**
 * Both places a body can live, kept separate.
 *
 * They are usually the same value seen twice — on the legacy widget `value`
 * IS an accessor over the element. But they can diverge: a frontend that syncs
 * `widget.value` back from the textarea only on blur leaves the widget stale
 * for the whole time the user is typing. Callers need to know which one they
 * are looking at to pick correctly, hence the split; `null` distinguishes
 * "there is no such source" from "it is empty".
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

/**
 * Read the node's current prompt.
 *
 * Prefers the backing element over `widget.value`: on some frontends the
 * widget value is only synced back from the element on blur, so mid-typing the
 * element is ahead. Reading the element is what makes the binding feel live.
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

/* --------------------------------------------------------------------------
   Writing
   -------------------------------------------------------------------------- */

/**
 * Push a body (and optionally a record id) into a node's widgets.
 *
 * This is the widget-poking half of modal/target.js's `loadIntoNode`,
 * extracted so the live binding and the explicit `Load into node` button take
 * exactly the same path — two code paths writing the same widget is how they
 * drift.
 *
 * ORDER MATTERS, and the reason is documented in modal/target.js: assign
 * `.value` FIRST, then invoke the callback. ComfyUI's own widget callbacks are
 * not trustworthy (the old node's domain records one that "resets widget state
 * and fights our async update"), so the value is committed before one can run
 * and every invocation is individually wrapped.
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

  // Suppress our own observers for the duration of the write. `lastSeen` is
  // the real echo guard; this just avoids pointless work in layers A and B.
  const st = BINDINGS.get(node);
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
      /* cosmetic */
    }
  } finally {
    if (st) st.writing = prevWriting;
  }

  return { ok: true };
}

/* --------------------------------------------------------------------------
   Observing — three independent layers
   --------------------------------------------------------------------------
   A  element `input`/`change`   the user typing on the canvas. Highest
                                 fidelity, fires per keystroke.
   B  `value` interception       programmatic writes: other extensions, undo,
                                 workflow load, ComfyUI's own blur-sync.
   C  poll()                     driven by the caller's existing heartbeat.
                                 The backstop for a frontend where neither of
                                 the above exists.

   Each installs independently. None is required.
   -------------------------------------------------------------------------- */

/**
 * Start observing a node's `text` widget.
 *
 * Idempotent per node: a second call on an already-bound node replaces the
 * change handler and returns a fresh unbind, without installing anything
 * twice. That matters because ComfyUI cache-busts extension module URLs, so
 * this module can genuinely be evaluated more than once on one page.
 *
 * @param {object} node
 * @param {(body: string, node: object) => void} onChange called only when the
 *   value actually differs from the last one we wrote or observed
 * @returns {() => void} unbind — safe to call more than once
 */
export function bindNode(node, onChange) {
  if (!node || typeof onChange !== "function") return () => {};

  const existing = BINDINGS.get(node);
  if (existing) {
    existing.handlers.add(onChange);
    return () => {
      existing.handlers.delete(onChange);
      if (!existing.handlers.size) teardown(node);
    };
  }

  const st = {
    node,
    handlers: new Set([onChange]),
    lastSeen: null,
    writing: false,
    widget: null,
    el: null,
    detach: [],
    detachA: null, // layer A's own teardown, so a re-rendered element can swap
    declinedB: false, // layer B is impossible here; stop retrying it
  };
  BINDINGS.set(node, st);

  const seed = readNodeText(node);
  st.lastSeen = seed ? seed.body : null;

  installLayerA(st);
  installLayerB(st);

  return () => {
    const cur = BINDINGS.get(node);
    if (!cur) return;
    cur.handlers.delete(onChange);
    if (!cur.handlers.size) teardown(node);
  };
}

/** Fan a value out to every subscriber, dropping echoes and no-ops. */
function emit(st, raw) {
  const body = str(raw);
  if (st.writing) return;
  if (st.lastSeen !== null && body === st.lastSeen) return;
  st.lastSeen = body;
  for (const fn of Array.from(st.handlers)) {
    try {
      fn(body, st.node);
    } catch (err) {
      warnOnce("bind-handler", "a node-binding handler threw", err);
    }
  }
}

/* ---- Layer A: the backing element ---------------------------------------- */

function installLayerA(st) {
  const w = findWidget(st.node, TEXT_WIDGET);
  if (!w) return; // widgets not wired yet — poll() will come back around
  st.widget = w;
  const el = widgetElement(w);
  if (!el || typeof el.addEventListener !== "function") return;
  if (st.el === el) return; // already listening on exactly this element

  // A frontend that re-renders the widget hands us a NEW element; the old
  // listeners are then attached to a detached node and would never fire again.
  if (st.el && st.detachA) {
    try {
      st.detachA();
    } catch (_) {
      /* the old element is going away anyway */
    }
    const i = st.detach.indexOf(st.detachA);
    if (i >= 0) st.detach.splice(i, 1);
    st.detachA = null;
  }
  st.el = el;

  const handler = () => emit(st, el.value);
  try {
    // `input` covers typing; `change` covers paste-and-blur on frontends that
    // batch, and IME commits on some browsers.
    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
    st.detachA = () => {
      el.removeEventListener("input", handler);
      el.removeEventListener("change", handler);
    };
    st.detach.push(st.detachA);
  } catch (err) {
    st.el = null;
    warnOnce("bind-layer-a", "could not listen on the text widget element", err);
  }
}

/* ---- Layer B: `value` interception --------------------------------------- */

/**
 * Wrap `widget.value` so we see programmatic writes.
 *
 * THE TRAP: on the legacy frontend `value` is ALREADY an accessor, defined
 * over the widget's detached textarea. Installing a plain data property on top
 * of it silently disconnects the widget from its own element — the canvas
 * stops updating and nothing throws. So the original descriptor is captured
 * (walking the prototype chain, since it may be defined on a class) and the
 * new accessor delegates to it. When the original was a data property we keep
 * a private backing field instead.
 *
 * `unbind` restores exactly what was there before.
 */
function installLayerB(st) {
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
    st.declinedB = true;
    warnOnce("bind-layer-b-desc", "could not inspect the text widget descriptor", err);
    return;
  }

  // Non-configurable means we cannot redefine it and cannot restore it either.
  if (desc && desc.configurable === false) {
    st.declinedB = true;
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
        emit(st, v);
      },
    });
    w.__plBound = true;
  } catch (err) {
    st.declinedB = true;
    warnOnce("bind-layer-b", "could not intercept the text widget value", err);
    return;
  }

  st.detach.push(() => {
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

/* ---- Layer C: polling ----------------------------------------------------- */

/**
 * The backstop. Call from an existing timer — modal/index.js already runs a
 * 1 s heartbeat for target resolution, so this costs one string compare per
 * second and no new timer.
 *
 * It doubles as the late-install path: `nodeCreated` fires before ComfyUI has
 * wired widget values, so layers A and B may have had nothing to attach to at
 * bind time. Each poll retries them, which is the same "several independent
 * triggers beat one guessed timeout" approach `ensureHydrated` already uses.
 */
export function poll(node) {
  const st = BINDINGS.get(node);
  if (!st || st.writing) return;

  // Late install. `nodeCreated` fires before ComfyUI has wired widget values,
  // and on a DOM-widget frontend the textarea can materialise later still (or
  // be replaced by a re-render), so neither layer is necessarily installable at
  // bind time. Retry until each has attached or definitively declined —
  // installLayerA is idempotent per element and swaps on a new one.
  // Layer A runs unconditionally, not just when `st.el` is empty: a frontend
  // that re-renders the widget hands us a DIFFERENT textarea, and the old one
  // still answers `st.el` while being detached and permanently silent. Only
  // re-resolving every tick catches that, and it costs one array find plus a
  // few property reads per second.
  installLayerA(st);
  if (st.widget && !st.widget.__plBound && !st.declinedB) installLayerB(st);

  const textW = st.widget || findWidget(node, TEXT_WIDGET);
  if (!textW) return;
  const raw = rawValues(textW);

  if (st.lastSeen === null) {
    st.lastSeen = raw.el !== null ? raw.el : str(raw.widget);
    return;
  }

  // WHEN AN ELEMENT EXISTS IT IS THE ONLY SOURCE. Do not "check both to be
  // safe" — some frontends sync `widget.value` back from the textarea only on
  // blur, so mid-typing the two legitimately disagree, and polling both would
  // let the stale one overwrite the panel with the pre-edit text on the very
  // next tick. Falling back to `widget.value` is for the elementless case,
  // which is also the only case where layer B declining leaves nothing else.
  const cur = raw.el !== null ? raw.el : raw.widget;
  if (cur !== null && cur !== st.lastSeen) emit(st, cur);
}

/**
 * True when this node currently has a binding installed. Diagnostic: the
 * quickest console answer to "why is the panel not following this node".
 */
export function isBound(node) {
  return !!node && BINDINGS.has(node);
}

function teardown(node) {
  const st = BINDINGS.get(node);
  if (!st) return;
  BINDINGS.delete(node);
  for (const fn of st.detach.splice(0)) {
    try {
      fn();
    } catch (err) {
      warnOnce("bind-teardown", "a node-binding teardown step threw", err);
    }
  }
  st.handlers.clear();
}
