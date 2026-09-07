import { warnOnce } from "../shared/singleton.js";
import { paintFace } from "./face.js";
import { findWidget, hidePromptIdWidget } from "./widgets.js";

/** nodeCreated can precede widget wiring and workflow value restoration.
 * Retry from rAF, the delayed entry hook, and first modal open; set the
 * hydrated flag only after widgets exist.
 *
 * @returns {boolean} true once hydration has actually happened
 */
export function ensureHydrated(node) {
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

/** Subscribe independently of the panel. No per-node timer is started: if
 * element/value hooks are unavailable, the preview waits for the modal
 * heartbeat to poll. A failed lazy import only costs live preview updates.
 */
function bindFace(node) {
  if (node.__plFaceBound) return;
  node.__plFaceBound = true;
  import("./bind.js")
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
        "web/prompt_librarian/node/bind.js is not available; the node card will not track edits made in the node's own text widget",
        err && err.message
      );
    });
}

/** Without backend metadata, keep the face usable from local widget values.
 */
async function refreshMeta(node) {
  const idW = findWidget(node, "prompt_id");
  const id = idW ? String(idW.value || "").trim() : "";
  if (!id) return;
  try {
    const api = await import("../api/meta.js");
    if (typeof api.fetchMeta !== "function") throw new Error("fetchMeta missing");
    const meta = await api.fetchMeta(id);
    if (meta) paintFace(node, meta);
  } catch (err) {
    warnOnce(
      "api-missing",
      "the transport layer is not available (node metadata not loaded)",
      err && err.message
    );
  }
}
