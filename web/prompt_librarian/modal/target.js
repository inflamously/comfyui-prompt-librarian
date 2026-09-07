import { cls } from "../shared/dom.js";
import { API } from "../api/routes.js";
import { invalidateMeta } from "../api/meta.js";
import { readNodeText, writeNodeText } from "../node/bind.js";
import { ARROW, CARET } from "./glyphs.js";
import { hostApp } from "./host.js";
import { inst, setState } from "./state.js";

export const NODE_CLASS = "PromptLibrarian";

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

/** Resolve by ID on every call; retained node objects can outlive deletion
 * or workflow replacement.
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

/** Share writeNodeText with live binding so value/callback ordering agrees.
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

/** Count real record loads from either selection or explicit load, once per change.
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
