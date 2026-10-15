/* Sets up a PromptLibrarian node inside the ComfyUI graph, once per node:
 *
 *   1. hide the prompt_id widget (still serialized with the workflow)
 *   2. repaint the node card whenever `text` is edited on the canvas
 *   3. paint the card from the local widget values
 *   4. load the linked record's metadata (label, rating, uses) and repaint
 *
 * Timing: nodeCreated can fire before ComfyUI has wired the widgets or restored
 * the workflow's values, so setup only proceeds once the `text` widget exists.
 * index.js retries from nodeCreated, the next animation frame, a 500 ms timer,
 * and the first Open Librarian click; the __plSetUp flag makes it run once.
 *
 * This does not open or configure the modal; it only prepares the node itself.
 */

import { warnOnce } from "../../shared/singleton.js";
import { fetchMeta } from "../../api/meta.js";
import { paintFace } from "./face.js";
import { watchNodeText } from "./text-sync.js";
import { findWidget, hidePromptIdWidget } from "./widgets.js";

/** @returns {boolean} true once the node has been set up (now or earlier);
 *   false when its widgets are not wired yet and a later retry is needed
 */
export function setupGraphNode(node) {
  if (!node || node.__plSetUp) return true;
  if (!Array.isArray(node.widgets) || !node.widgets.length) return false;
  if (!findWidget(node, "text")) return false;

  node.__plSetUp = true;
  hidePromptIdWidget(node);
  repaintCardOnTextEdit(node);
  paintFace(node);
  loadLinkedRecordMeta(node);
  return true;
}

/** Subscribe the node card to `text` edits, independently of the modal. No
 * per-node timer is started: if element/value hooks are unavailable, the card
 * waits for the modal heartbeat to poll.
 */
function repaintCardOnTextEdit(node) {
  if (node.__plFaceBound) return;
  node.__plFaceBound = true;
  const unwatch = watchNodeText(node, () => paintFace(node, node.__plMeta));
  // LiteGraph calls onRemoved when the node leaves the graph. Chain rather
  // than replace — another extension may have installed one.
  const prev = node.onRemoved;
  node.onRemoved = function (...args) {
    try {
      unwatch();
    } catch (_) {
    }
    node.__plFaceBound = false;
    if (typeof prev === "function") return prev.apply(this, args);
    return undefined;
  };
}

/** Fetch metadata for the record named by prompt_id and repaint the card.
 * Unlinked nodes, or a missing backend, keep the local-only card.
 */
async function loadLinkedRecordMeta(node) {
  const idW = findWidget(node, "prompt_id");
  const id = idW ? String(idW.value || "").trim() : "";
  if (!id) return;
  try {
    const meta = await fetchMeta(id);
    if (!meta) return;
    node.__plMeta = meta;
    paintFace(node, meta);
  } catch (err) {
    warnOnce(
      "meta-failed",
      "could not load the linked prompt's metadata",
      err && err.message
    );
  }
}
