/* ==========================================================================
   Prompt Librarian — target node resolution and `Load into node`
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { cls } from "../shared/dom.js";
import { API } from "../api/routes.js";
import { invalidateMeta } from "../api/meta.js";
import { readNodeText, writeNodeText } from "../node/bind.js";
import { ARROW, CARET } from "./glyphs.js";
import { hostApp } from "./host.js";
import { inst, setState } from "./state.js";

export const NODE_CLASS = "PromptLibrarian";

/** Every PromptLibrarian node currently in the graph. Never cached. */
export function librarianNodes() {
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
export function resolveTarget() {
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

export function nodeLabel(node) {
  if (!node) return "";
  const title = node.title || "Prompt Librarian";
  return `#${node.id} ${title}`;
}

/** Repaint the header chip and the `targetOk` flag. */
export function refreshTarget() {
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
    ? "The editor mirrors this node. Click to target a different one."
    : any.length
    ? "The targeted node is gone. Click to pick another; everything else still works."
    : "add a Prompt Librarian node first";
  chip.disabled = false;
}

/**
 * Push a record into the target node's widgets.
 *
 * The widget poking itself lives in node/bind.js `writeNodeText` — the live
 * binding and this explicit button must take the same path, because two code
 * paths writing the same widget is exactly how they drift apart. The ordering
 * rule (value first, then callback) and its rationale live there with it.
 *
 * What stays here is everything that is specific to *loading a record*: target
 * resolution, selecting the node on the canvas, and the usage ping.
 *
 * IDEMPOTENT. If the node already holds exactly this body under exactly this
 * id, nothing is written and — crucially — no usage ping is sent. Re-activating
 * the row that is already loaded is a no-op the user cannot tell apart from a
 * load, so counting it would inflate the usage stats with clicks that changed
 * nothing. The comparison reads the node itself rather than a remembered
 * "last loaded" value, because the user can edit the textarea on the canvas
 * afterwards — and then re-loading the record IS a real load.
 *
 * @param {object} record needs at least {body}; {id} enables usage tracking
 * @returns {{ok: boolean, reason?: string, unchanged?: boolean}}
 */
export function loadIntoNode(record) {
  if (!record) return { ok: false, reason: "no_record" };
  const node = resolveTarget();
  if (!node) {
    refreshTarget();
    return { ok: false, reason: "stale_target" };
  }

  const body = record.body == null ? "" : String(record.body);
  const id = record.id == null ? "" : String(record.id);

  const cur = readNodeText(node);
  if (cur && cur.body === body && String(cur.id || "") === id) {
    return { ok: true, unchanged: true };
  }

  const res = writeNodeText(node, { body, id }, { canvas: hostApp() && hostApp().canvas });
  if (!res.ok) return res;

  try {
    const canvas = hostApp() && hostApp().canvas;
    if (canvas && typeof canvas.selectNode === "function") canvas.selectNode(node, false);
  } catch (_) {
    /* purely cosmetic */
  }

  noteUsage(id, body);
  return { ok: true };
}

/**
 * Count one use of a record.
 *
 * Shared with modal/binding.js so that BOTH ways a record reaches the node —
 * `Load into node` and picking a row in the sidebar — count once and only
 * once. They used to disagree: selection wrote the record silently while only
 * the button counted, so pressing Enter on the row you had just clicked was
 * the only thing that registered.
 *
 * No-op without an id: an unsaved buffer has nothing to count against.
 */
export function noteUsage(id, body) {
  const rid = id == null ? "" : String(id);
  if (!rid) return;
  // Fire and forget: a usage-tracking failure must never block the load.
  Promise.resolve()
    .then(() => API.usage(rid, { body: body == null ? "" : String(body) }))
    .catch(() => {});
  invalidateMeta([rid]);
}
