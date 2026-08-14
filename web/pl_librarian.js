/* ==========================================================================
   Prompt Librarian — extension entry
   --------------------------------------------------------------------------
   THIS IS THE ONLY FILE IN THIS PACK ALLOWED TO HAVE IMPORT-TIME SIDE EFFECTS.

   ComfyUI imports every .js under WEB_DIRECTORY as an extension, so every
   module under web/pl/ is loaded whether or not we ask for it — those files
   are inert by construction (exports and const data only). All the wiring
   lives here: one registerExtension call, one stylesheet, one node hook.

   Extension name is `prompt-librarian.ui`. The OLD node registers
   `prompt-library.ui` (web/prompt_library.js) — different node class,
   different routes, different store, zero overlap. Deleting either file must
   leave the other working, which is also why nothing here imports from
   web/prompt_library.js.
   ========================================================================== */

import { app } from "../../scripts/app.js";
import {
  NS,
  ensureStyles,
  firstLine,
  fmtInt,
  singleton,
  stars,
  truncate,
  warnOnce,
} from "./pl/dom.js";

const NODE_CLASS = "PromptLibrarian";
const MULT = String.fromCharCode(0x00d7); // "×", as in "used 41×"
const HEAD_MAX = 44; // widget labels are drawn on the canvas; keep them short
const BODY_MAX = 52;

/* --------------------------------------------------------------------------
   Host injection point.

   Other modules never import this file (that would re-run registerExtension
   under a second cache-busted URL). They read the host off the shared
   singleton bag instead. `app` is captured here, in the one place that is
   already coupled to ComfyUI's module layout.
   -------------------------------------------------------------------------- */
function host() {
  return singleton("host", () => ({ app: null }));
}

/* --------------------------------------------------------------------------
   Widgets
   -------------------------------------------------------------------------- */

function findWidget(node, name) {
  const list = node && node.widgets;
  if (!Array.isArray(list)) return null;
  return list.find((w) => w && w.name === name) || null;
}

/**
 * Hide the `prompt_id` widget. It must stay in `node.widgets` so LiteGraph
 * keeps serializing it into the workflow JSON (that string is the only link
 * between a workflow and a library record), but it has no business taking up
 * a row on the canvas — the user never types a uuid by hand.
 *
 * `type = "hidden"` is the documented LiteGraph way. Some frontends still
 * reserve layout space for it, so we also stub `computeSize` to the standard
 * [0, -4] (the -4 cancels the inter-widget margin). Both are guarded: the
 * widget may legitimately be absent if the Python side changed.
 */
function hidePromptIdWidget(node) {
  const w = findWidget(node, "prompt_id");
  if (!w || w.__plHidden) return;
  try {
    w.__plOrigType = w.type;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    w.__plHidden = true;
  } catch (err) {
    warnOnce("hide-prompt-id", "could not hide the prompt_id widget", err);
  }
}

/**
 * Set a widget's visible text. Assigns BOTH `name` and `label`: LiteGraph
 * draws `label ?? name` in some builds and `name` in others, and the two cost
 * nothing to keep in sync. Cheap insurance.
 */
function setWidgetLabel(w, text) {
  if (!w) return;
  w.name = text;
  w.label = text;
}

/* --------------------------------------------------------------------------
   Node face — TIER CONTRACT
   --------------------------------------------------------------------------
   Tier 1 (shipped, proven): three `node.addWidget("button", …)` widgets.
     [0] head    `ballet_drift_v3  ★★★★☆  used 41×`
     [1] preview one truncated line of the body
     [2] `Open Librarian`
   Every one of them opens the modal. A button whose label renders oddly is
   still a working button, so the node can never become a dead end.

   Tier 2 (later wave): a `.pl-node-card` DOM widget with clickable stars and
   a near-dupe badge. Strictly an upgrade — it is attempted only when
   `addDOMWidget` exists, is wrapped in try/catch, and is verified after one
   rAF by checking `el.isConnected` (some frontends accept the call and
   silently drop the element). Any failure tears down and falls back to
   Tier 1. `Open Librarian` exists in BOTH tiers.
   -------------------------------------------------------------------------- */

/**
 * TIER 2 — the richer `.pl-node-card` DOM face.
 *
 * `addDOMWidget` is NOT a verified API in this installation (nothing in the
 * old node uses it), so this is defence in three layers:
 *   1. `typeof` check      — the method may simply not exist;
 *   2. `try/catch`         — it may exist with a different signature and throw;
 *   3. post-rAF `isConnected` — it may accept the call and silently never
 *      mount the element, which no exception would reveal.
 * Any failure tears the widget back out and installs the proven Tier-1 face.
 *
 * The `Open Librarian` button is added by the CALLER in both tiers, so the
 * node always has a working entry point even if this card renders oddly.
 *
 * @returns {boolean} true if a DOM face was installed (pending verification)
 */
function buildDomFace(node) {
  if (typeof node.addDOMWidget !== "function") return false;
  if (typeof document === "undefined") return false;

  let el = null;
  let widget = null;
  try {
    el = buildNodeCard(node);
    widget = node.addDOMWidget("pl_card", "div", el, { serialize: false });
    if (!widget) return false;
  } catch (err) {
    warnOnce("dom-widget", "addDOMWidget threw; using the button face", err);
    return false;
  }

  node.__plFace = { tier: 2, el, widget, card: el.__plParts };

  // Verify on the next frame: a frontend may accept the call and never mount
  // the element. If it is not connected, tear down and fall back to Tier 1.
  const verify = () => {
    if (el && el.isConnected) return;
    try {
      if (widget && typeof node.removeWidget === "function") node.removeWidget(widget);
    } catch (_) {
      /* best effort — a stranded widget is better than a thrown hook */
    }
    warnOnce("dom-widget-mount", "addDOMWidget did not mount; using the button face");
    node.__plFace = null;
    buildButtonFace(node);
    paintFace(node, node.__plMeta);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(verify);
  else setTimeout(verify, 0);

  return true;
}

/**
 * The `.pl-node-card` element. Every class here is defined in librarian.css,
 * which `setup()` has already injected.
 */
function buildNodeCard(node) {
  const mk = (tag, cls) => {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
  };

  // Structure and class names come straight from the `.pl-node-card` block in
  // librarian.css — head (name / stars / used), clamped body, foot (dupe badge).
  const el = mk("div", "pl-node-card");
  const head = mk("div", "pl-nc-head");
  const name = mk("div", "pl-nc-name");
  const starRow = mk("span", "pl-stars");
  const used = mk("span", "pl-nc-used");
  const body = mk("div", "pl-nc-body");
  const foot = mk("div", "pl-nc-foot");
  const dupes = mk("span", "pl-badge-dupe");

  starRow.setAttribute("role", "radiogroup");
  starRow.setAttribute("aria-label", "rating");
  dupes.hidden = true;

  head.appendChild(name);
  head.appendChild(starRow);
  head.appendChild(used);
  foot.appendChild(dupes);
  el.appendChild(head);
  el.appendChild(body);
  el.appendChild(foot);

  // A pointerdown inside the card must not start a canvas node-drag, or the
  // node runs away from the cursor the moment you click a star.
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  // Clicking the card body (not a star) is a second way into the modal.
  el.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest(".pl-stars")) return;
    openLibrarian(node);
  });

  el.__plParts = { name, body, head, foot, starRow, used, dupes };
  return el;
}

/** Repaint the five clickable stars, wired to an optimistic rate call. */
function paintStars(node, starRow, rating) {
  const current = Number(rating) || 0;
  while (starRow.firstChild) starRow.removeChild(starRow.firstChild);
  for (let i = 1; i <= 5; i += 1) {
    const s = document.createElement("span");
    s.setAttribute("role", "radio");
    s.setAttribute("aria-checked", String(i === current));
    s.setAttribute("tabindex", "-1");
    s.title = `rate ${i}`;
    s.textContent = i <= current ? "★" : "☆";
    s.addEventListener("click", (e) => {
      e.stopPropagation();
      rateFromNode(node, i === current ? 0 : i);
    });
    starRow.appendChild(s);
  }
}

/**
 * Optimistic rating straight from the node card: paint first, then write.
 * On failure we repaint from the last known meta rather than leaving a lie
 * on the canvas.
 */
async function rateFromNode(node, rating) {
  const idW = findWidget(node, "prompt_id");
  const id = idW && String(idW.value || "").trim();
  if (!id) return;
  const prev = node.__plMeta || {};
  node.__plMeta = { ...prev, rating };
  paintFace(node, node.__plMeta);
  try {
    const mod = await import("./pl/api.js");
    await mod.API.rate(id, rating);
    mod.invalidateMeta([id]);
  } catch (err) {
    node.__plMeta = prev;
    paintFace(node, node.__plMeta);
    warnOnce("rate-from-node", "could not save the rating", err);
  }
}

/** TIER 1 — the guaranteed face. Idempotent. */
function buildButtonFace(node) {
  if (node.__plFace) return node.__plFace;
  const open = () => openLibrarian(node);
  const face = {
    tier: 1,
    head: node.addWidget("button", "Prompt Librarian", null, open),
    body: node.addWidget("button", "(no prompt loaded)", null, open),
  };
  // Button widgets have no meaningful value to serialize.
  for (const key of ["head", "body"]) {
    if (face[key]) face[key].serialize = false;
  }
  node.__plFace = face;
  return face;
}

/**
 * Repaint the face from whatever we know. Handles BOTH tiers: the DOM card
 * when one mounted, the button labels otherwise. Callers never care which.
 *
 * @param {object} node
 * @param {{name?:string, rating?:number, used?:number, body?:string,
 *          near_dupes?:number}} [meta]
 */
function paintFace(node, meta) {
  const face = node.__plFace;
  if (!face) return;
  const textW = findWidget(node, "text");
  const idW = findWidget(node, "prompt_id");
  const body = (meta && meta.body) || (textW ? String(textW.value || "") : "");
  const named = meta && meta.name;
  const linked = idW && String(idW.value || "").trim();

  // "(unsaved)" = no library link at all. "(unsynced)" = the workflow carries
  // an id but this library has no record for it — a workflow from another
  // machine. Both still run: `text` is the source of truth.
  const name = named || (linked ? "(unsynced)" : "(unsaved)");
  const rating = meta ? meta.rating : 0;
  const uses = meta && meta.used ? meta.used : 0;
  const dupes = meta && meta.near_dupes ? meta.near_dupes : 0;

  if (face.tier === 2 && face.card) {
    const p = face.card;
    p.name.textContent = name;
    p.body.textContent = firstLine(body, 140) || "(empty prompt)";
    p.used.textContent = uses ? `used ${fmtInt(uses)}${MULT}` : "unused";
    paintStars(node, p.starRow, rating);
    p.dupes.textContent = dupes ? `${fmtInt(dupes)} near-dupes` : "";
    p.dupes.hidden = !dupes;
  } else {
    const used = uses ? `  used ${fmtInt(uses)}${MULT}` : "";
    setWidgetLabel(face.head, truncate(`${name}  ${stars(rating)}${used}`, HEAD_MAX));
    setWidgetLabel(face.body, firstLine(body, BODY_MAX) || "(empty prompt)");
  }

  if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
}

/* --------------------------------------------------------------------------
   Hydration
   -------------------------------------------------------------------------- */

/**
 * Idempotent, retry-tolerant node hydration.
 *
 * THE QUIRK: `nodeCreated` fires during graph construction, BEFORE ComfyUI has
 * finished wiring widget option references and (on workflow load) before the
 * serialized widget VALUES have been applied. The old node documents this and
 * works around it with a single `setTimeout(…, 500)` — see the comment above
 * the last line of web/prompt_library.js ("Defer initial load: nodeCreated
 * fires during graph init before ComfyUI finishes wiring widget option
 * references"). 500 ms is the value that installation has actually proven, so
 * it is kept verbatim here.
 *
 * A single timeout is a guess, though, so this is driven by three independent
 * triggers — rAF (fast path, usually enough), the proven 500 ms timeout, and
 * the first modal open (the guaranteed backstop, since by then the user has
 * definitely interacted with a fully-built graph). Each call bails harmlessly
 * if the widgets still are not there, leaving `__plHydrated` unset so a later
 * trigger retries. Strictly safer than one timeout, and free.
 *
 * @returns {boolean} true once hydration has actually happened
 */
function ensureHydrated(node) {
  if (!node || node.__plHydrated) return true;
  // Widgets not wired yet — a later trigger will come back around.
  if (!Array.isArray(node.widgets) || !node.widgets.length) return false;
  if (!findWidget(node, "text")) return false;

  node.__plHydrated = true;
  hidePromptIdWidget(node);
  bindFace(node);
  paintFace(node);
  refreshMeta(node);
  return true;
}

/**
 * Repaint the node's face whenever its `text` widget changes.
 *
 * Without this the preview line is written once at hydration and then lies:
 * `paintFace` reads `textW.value`, but nothing was ever watching it, so typing
 * into the node's own widget left the card showing the previous prompt.
 *
 * Deliberately independent of the panel. This is about the NODE being honest
 * about itself; the panel's two-way binding is modal.js's business and both
 * can be installed at once — bind.js is idempotent per node and reference
 * counts its subscribers.
 *
 * KNOWN LIMIT, accepted on purpose: no timer is started here, so bind.js's
 * polling backstop does not run for the card on its own. On a frontend where
 * neither the element listener nor the value interception can be installed the
 * preview goes stale again until the panel is opened on this node — modal.js's
 * heartbeat drives the poll then, and the resulting event reaches every
 * subscriber including this one. A per-node interval running for the lifetime
 * of every graph is not worth a preview line.
 *
 * The import is lazy and guarded like every other cross-module reach in this
 * file: a missing bind.js costs a stale preview line, nothing more.
 */
function bindFace(node) {
  if (node.__plFaceBound) return;
  node.__plFaceBound = true;
  import("./pl/bind.js")
    .then((bind) => {
      if (typeof bind.bindNode !== "function") throw new Error("bindNode missing");
      const off = bind.bindNode(node, () => paintFace(node, node.__plMeta));
      // LiteGraph calls onRemoved when the node leaves the graph. Chain rather
      // than replace — another extension may have installed one.
      const prev = node.onRemoved;
      node.onRemoved = function (...args) {
        try {
          off();
        } catch (_) {
          /* best effort */
        }
        node.__plFaceBound = false;
        if (typeof prev === "function") return prev.apply(this, args);
        return undefined;
      };
    })
    .catch((err) => {
      node.__plFaceBound = false;
      warnOnce(
        "bind-missing",
        "web/pl/bind.js is not available; the node card will not track edits made in the node's own text widget",
        err && err.message
      );
    });
}

/**
 * Pull the record's name/rating/used from the backend for the node face.
 *
 * `pl/api.js` is owned by a later wave. Until it lands this resolves to
 * nothing and the face simply shows what the local widgets already know —
 * which is a complete, usable node, just without stars and a usage count.
 */
async function refreshMeta(node) {
  const idW = findWidget(node, "prompt_id");
  const id = idW ? String(idW.value || "").trim() : "";
  if (!id) return;
  try {
    const api = await import("./pl/api.js");
    if (typeof api.fetchMeta !== "function") throw new Error("fetchMeta missing");
    const meta = await api.fetchMeta(id);
    if (meta) paintFace(node, meta);
  } catch (err) {
    warnOnce(
      "api-missing",
      "pl/api.js is not available yet (node metadata not loaded) — this is expected until the API module lands",
      err && err.message
    );
  }
}

/* --------------------------------------------------------------------------
   Modal
   -------------------------------------------------------------------------- */

/**
 * Open the librarian for a node. `pl/modal.js` is imported LAZILY and inside
 * a try/catch: it is owned by a later wave, and the extension must load and
 * the node must work without it. A missing modal logs once and no-ops; it
 * never throws into LiteGraph's event handling.
 */
async function openLibrarian(node) {
  ensureStyles();
  ensureHydrated(node); // third and final hydration trigger
  try {
    const modal = await import("./pl/modal.js");
    if (typeof modal.setHost === "function") modal.setHost({ app });
    if (typeof modal.openModal !== "function") throw new Error("openModal missing");
    await modal.openModal({ targetNodeId: node ? node.id : null });
  } catch (err) {
    warnOnce(
      "modal-missing",
      "the librarian panel is not implemented yet (web/pl/modal.js). The node still works: `text` is the prompt and is saved with the workflow.",
      err && err.message
    );
  }
}

/* --------------------------------------------------------------------------
   Registration — the one and only side effect in this pack
   -------------------------------------------------------------------------- */

app.registerExtension({
  name: "prompt-librarian.ui",

  setup() {
    host().app = app;
    // Injected here, not at import time: the document head is guaranteed
    // ready by setup(), and a stylesheet request during module evaluation
    // competes with ComfyUI's own boot.
    ensureStyles();
  },

  nodeCreated(node) {
    if (!node || node.comfyClass !== NODE_CLASS) return;

    // Try the richer DOM card first; fall back to the proven button face.
    // buildDomFace() may still fall back asynchronously (post-rAF mount
    // verification), which is why it owns its own buildButtonFace() call.
    if (!buildDomFace(node)) buildButtonFace(node);

    // `Open Librarian` exists in BOTH tiers — it is the primary affordance and
    // must never depend on the DOM card having rendered correctly. Added here
    // rather than inside either face builder so exactly one is ever created.
    if (!node.__plOpenBtn) {
      node.__plOpenBtn = node.addWidget("button", "Open Librarian", null, () =>
        openLibrarian(node),
      );
      if (node.__plOpenBtn) node.__plOpenBtn.serialize = false;
    }

    // Trigger 1: next frame. Trigger 2: the 500 ms the old node proved.
    // Trigger 3 is the first modal open, inside openLibrarian().
    if (!ensureHydrated(node)) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => ensureHydrated(node));
      }
      setTimeout(() => ensureHydrated(node), 500);
    }
  },
});

console.debug(`${NS} librarian ui registered`);
