/* ==========================================================================
   The fake LiteGraph node — the most-edited file in the harness.

   node/bind.js names three shapes a multiline STRING widget has taken across
   ComfyUI generations, and defends against all of them with three observation
   layers. Those defences are normally unreachable: any given install only ever
   exercises one shape. `flavour` makes each one reachable on demand, which is
   what turns untestable-by-construction defensive code into code you can trip.

   Every widget name here comes from prompt_librarian/node.py INPUT_TYPES.
   ========================================================================== */

import { app } from "./fake-app.js";

/** Widget names the pack looks up by name. Keep in step with node.py. */
export const WIDGETS = ["text", "prompt_id", "seed", "resolve_wildcards", "track_usage"];

let nextId = 1;

/**
 * The "legacy" multiline widget: `value` is an ACCESSOR over a detached
 * textarea at `inputEl`.
 *
 * This is the shape bind.js's descriptor walk exists for — a naive
 * Object.defineProperty over it silently disconnects the widget from its own
 * element, and nothing throws.
 */
function legacyText(name, value) {
  const inputEl = document.createElement("textarea");
  inputEl.value = value;
  const w = { type: "customtext", name, inputEl, callback: null, serialize: true, options: {} };
  Object.defineProperty(w, "value", {
    configurable: true,
    enumerable: true,
    get: () => inputEl.value,
    set: (v) => {
      inputEl.value = v == null ? "" : String(v);
    },
  });
  return w;
}

/**
 * The "domwidget" shape: `element` is a WRAPPER containing the textarea, and
 * `value` is a plain data property synced from the element on blur only — so
 * mid-typing the two legitimately disagree, which is the case poll() exists for.
 */
function domText(name, value) {
  const element = document.createElement("div");
  const ta = document.createElement("textarea");
  ta.value = value;
  element.appendChild(ta);
  const w = { type: "customtext", name, element, value, callback: null, options: {} };
  ta.addEventListener("blur", () => {
    w.value = ta.value;
  });
  return w;
}

/**
 * The "opaque" shape: no element at all and `value` defined non-configurable,
 * so bind.js's layer B must decline and fall back to polling.
 */
function opaqueText(name, value) {
  const w = { type: "customtext", name, callback: null, options: {} };
  let v = value;
  Object.defineProperty(w, "value", {
    configurable: false,
    enumerable: true,
    get: () => v,
    set: (x) => {
      v = x == null ? "" : String(x);
    },
  });
  return w;
}

const TEXT_FLAVOURS = { legacy: legacyText, domwidget: domText, opaque: opaqueText };

/**
 * Build a node the extension's `nodeCreated` will accept.
 *
 * @param {object} opts
 * @param {"legacy"|"domwidget"|"opaque"} [opts.flavour] multiline widget shape
 * @param {"ok"|"absent"|"throws"|"ghost"} [opts.domWidget] addDOMWidget behaviour.
 *   "ghost" accepts the call and never mounts the element — the only way to
 *   reach face.js's post-rAF isConnected teardown.
 * @param {number} [opts.lateWidgets] ms to delay populating `widgets`, or -1 to
 *   never populate. Reproduces the quirk hydrate.js's three triggers exist for.
 */
export function makeNode(opts = {}) {
  const {
    flavour = "legacy",
    domWidget = "ok",
    lateWidgets = 0,
    body = "a dancer in the rain",
  } = opts;

  const node = {
    id: nextId++,
    type: "PromptLibrarian",
    comfyClass: "PromptLibrarian",
    title: "Prompt Librarian",
    widgets: [],
    properties: {},
    size: [340, 220],
    flags: {},

    addWidget(type, name, value, callback, options) {
      const w = { type, name, value, callback, options: options || {} };
      node.widgets.push(w);
      node.__render();
      return w;
    },

    removeWidget(w) {
      const i = node.widgets.indexOf(w);
      if (i >= 0) node.widgets.splice(i, 1);
      node.__render();
    },

    setDirtyCanvas() {
      node.__render();
    },

    onRemoved: null,
  };

  /* -- the fake canvas: one <div> per node, one row per widget ------------- */
  node.__el = document.createElement("div");
  node.__el.className = "dev-node";
  node.__el.innerHTML =
    '<div class="dev-node-title"></div><div class="dev-node-dom"></div>' +
    '<div class="dev-node-widgets"></div>';

  node.__render = () => {
    node.__el.querySelector(".dev-node-title").textContent = `#${node.id} ${node.title}`;
    const host = node.__el.querySelector(".dev-node-widgets");
    host.textContent = "";
    for (const w of node.widgets) {
      // A hidden widget must visibly disappear, so hidePromptIdWidget can be
      // seen doing something. Real LiteGraph also honours computeSize.
      if (w.type === "hidden") continue;
      if (w.element) continue; // DOM widgets render themselves, above
      const row = document.createElement("div");
      row.className = "dev-widget";
      const el = w.inputEl || (w.type === "customtext" ? null : null);
      row.textContent = `${w.name ?? "(unnamed)"}: `;
      if (el) {
        row.appendChild(el);
      } else if (w.type === "button") {
        const b = document.createElement("button");
        b.textContent = String(w.name);
        b.onclick = () => w.callback && w.callback(w.value, app.canvas, node);
        row.textContent = "";
        row.appendChild(b);
      } else {
        const span = document.createElement("span");
        span.textContent = String(w.value);
        row.appendChild(span);
      }
      host.appendChild(row);
    }
  };

  /** Widgets that a real workflow save would serialise. */
  node.__serialised = () =>
    node.widgets.filter((w) => w.serialize !== false).map((w) => ({ name: w.name, value: w.value }));

  if (domWidget !== "absent") {
    node.addDOMWidget = (name, type, el, options) => {
      if (domWidget === "throws") throw new Error("fake host: addDOMWidget is unavailable");
      // "ghost" deliberately does not mount the element.
      if (domWidget === "ok") node.__el.querySelector(".dev-node-dom").appendChild(el);
      const w = { name, type, element: el, options: options || {} };
      node.widgets.push(w);
      return w;
    };
  }

  function populate() {
    node.widgets.unshift(
      { type: "toggle", name: "track_usage", value: true, options: {} },
      { type: "toggle", name: "resolve_wildcards", value: true, options: {} },
      { type: "number", name: "seed", value: 0, options: {} },
      { type: "text", name: "prompt_id", value: "", options: {} },
      (TEXT_FLAVOURS[flavour] || legacyText)("text", body),
    );
    node.__render();
  }

  if (lateWidgets === 0) populate();
  else if (lateWidgets > 0) setTimeout(populate, lateWidgets);
  // lateWidgets < 0: never populated. The node must still not throw.

  return node;
}

/** Reset the id counter, so a reset harness produces stable ids. */
export function resetNodeIds() {
  nextId = 1;
}
