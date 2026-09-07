/* Verify DOM widget attachment after a frame; some frontends silently drop it.
 * Fall back to button widgets on failure. The entry always adds Open Librarian.
 * The open callback is injected to avoid re-importing the extension entry.
 */

import { warnOnce } from "../shared/singleton.js";
import { firstLine, stars, truncate } from "../shared/text.js";
import { fmtInt } from "../shared/format.js";
import { findWidget, setWidgetLabel } from "./widgets.js";

const MULT = String.fromCharCode(0x00d7); // "×", as in "used 41×"
const HEAD_MAX = 44; // widget labels are drawn on the canvas; keep them short
const BODY_MAX = 52;

/**
 * Install the best face this frontend will accept.
 *
 * @param {object} node
 * @param {(node: object) => void} open opens the librarian panel
 * @returns {object} the installed face descriptor (`node.__plFace`)
 */
export function buildFace(node, open) {
  if (!buildDomFace(node, open)) return buildButtonFace(node, open);
  return node.__plFace;
}

/** A successful addDOMWidget call may not mount anything. Verify attachment
 * after a frame and fall back to buttons if it fails.
 *
 * @returns {boolean} true if a DOM face was installed (pending verification)
 */
function buildDomFace(node, open) {
  if (typeof node.addDOMWidget !== "function") return false;
  if (typeof document === "undefined") return false;

  let el = null;
  let widget = null;
  try {
    el = buildNodeCard(node, open);
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
    buildButtonFace(node, open);
    paintFace(node, node.__plMeta);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(verify);
  else setTimeout(verify, 0);

  return true;
}

function buildNodeCard(node, open) {
  const mk = (tag, cls) => {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
  };

  const el = mk("div", "pl-node-card");
  const head = mk("div", "pl-nc-head");
  const label = mk("div", "pl-nc-name");
  const starRow = mk("span", "pl-stars");
  const used = mk("span", "pl-nc-used");
  const body = mk("div", "pl-nc-body");
  const foot = mk("div", "pl-nc-foot");
  const dupes = mk("span", "pl-badge-dupe");

  starRow.setAttribute("role", "radiogroup");
  starRow.setAttribute("aria-label", "rating");
  dupes.hidden = true;

  head.appendChild(label);
  head.appendChild(starRow);
  head.appendChild(used);
  foot.appendChild(dupes);
  el.appendChild(head);
  el.appendChild(body);
  el.appendChild(foot);

  // A pointerdown inside the card must not start a canvas node-drag, or the
  // node runs away from the cursor the moment you click a star.
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => {
    if (e.target && e.target.closest && e.target.closest(".pl-stars")) return;
    open(node);
  });

  el.__plParts = { label, body, head, foot, starRow, used, dupes };
  return el;
}

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

/** Optimistically repaint ratings; restore known metadata if the write fails.
 */
async function rateFromNode(node, rating) {
  const idW = findWidget(node, "prompt_id");
  const id = idW && String(idW.value || "").trim();
  if (!id) return;
  const prev = node.__plMeta || {};
  node.__plMeta = { ...prev, rating };
  paintFace(node, node.__plMeta);
  try {
    const mod = await import("../api/index.js");
    await mod.API.rate(id, rating);
    mod.invalidateMeta([id]);
  } catch (err) {
    node.__plMeta = prev;
    paintFace(node, node.__plMeta);
    warnOnce("rate-from-node", "could not save the rating", err);
  }
}

function buildButtonFace(node, open) {
  if (node.__plFace) return node.__plFace;
  const onOpen = () => open(node);
  const face = {
    tier: 1,
    head: node.addWidget("button", "Prompt Librarian", null, onOpen),
    body: node.addWidget("button", "(no prompt loaded)", null, onOpen),
  };
  // Button widgets have no meaningful value to serialize.
  for (const key of ["head", "body"]) {
    if (face[key]) face[key].serialize = false;
  }
  node.__plFace = face;
  return face;
}

/** Update either face tier from the available metadata.
 *
 * @param {object} node
 * @param {{label?:string, rating?:number, used?:number, body?:string,
 *          near_dupes?:number}} [meta]
 */
export function paintFace(node, meta) {
  const face = node.__plFace;
  if (!face) return;
  const textW = findWidget(node, "text");
  const idW = findWidget(node, "prompt_id");
  const body = (meta && meta.body) || (textW ? String(textW.value || "") : "");
  const linked = idW && String(idW.value || "").trim();

  // An unknown linked ID is unsynced, not unsaved; either still runs from text.
  const label = (meta && meta.label) || (linked ? "(unsynced)" : "(unsaved)");
  const rating = meta ? meta.rating : 0;
  const uses = meta && meta.used ? meta.used : 0;
  const dupes = meta && meta.near_dupes ? meta.near_dupes : 0;

  if (face.tier === 2 && face.card) {
    const p = face.card;
    p.label.textContent = label;
    p.body.textContent = firstLine(body, 140) || "(empty prompt)";
    p.used.textContent = uses ? `used ${fmtInt(uses)}${MULT}` : "unused";
    paintStars(node, p.starRow, rating);
    p.dupes.textContent = dupes ? `${fmtInt(dupes)} near-dupes` : "";
    p.dupes.hidden = !dupes;
  } else {
    const used = uses ? `  used ${fmtInt(uses)}${MULT}` : "";
    setWidgetLabel(face.head, truncate(`${label}  ${stars(rating)}${used}`, HEAD_MAX));
    setWidgetLabel(face.body, firstLine(body, BODY_MAX) || "(empty prompt)");
  }

  if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
}
