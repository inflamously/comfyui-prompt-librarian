import { hostApp } from "./host.js";
import { inst, setState } from "../state.js";

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

/** Publish a fresh graph snapshot, including label/availability changes at the same ID. */
export function refreshTarget() {
  const node = resolveTarget();
  setState({
    ...(inst().state.targetOk !== !!node ? { targetOk: !!node } : {}),
    target: { label: nodeLabel(node), hasNodes: librarianNodes().length > 0 },
  });
}
