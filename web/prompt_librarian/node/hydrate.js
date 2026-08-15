/* ==========================================================================
   Prompt Librarian — node hydration
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Everything that has to happen to a node ONCE its widgets actually exist:
   hide `prompt_id`, subscribe the card to the binder, paint, and pull the
   record's metadata.
   ========================================================================== */

import { warnOnce } from "../shared/singleton.js";
import { paintFace } from "./face.js";
import { findWidget, hidePromptIdWidget } from "./widgets.js";

/**
 * Idempotent, retry-tolerant node hydration.
 *
 * THE QUIRK: `nodeCreated` fires during graph construction, BEFORE ComfyUI has
 * finished wiring widget option references and (on workflow load) before the
 * serialized widget VALUES have been applied. The old node documents this and
 * works around it with a single `setTimeout(…, 500)` — see the comment above
 * the last line of web/prompt_store/index.js ("Defer initial load: nodeCreated
 * fires during graph init before ComfyUI finishes wiring widget option
 * references"). 500 ms is the value that installation has actually proven, so
 * it is kept verbatim in the entry.
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

/**
 * Repaint the node's face whenever its `text` widget changes.
 *
 * Without this the preview line is written once at hydration and then lies:
 * `paintFace` reads `textW.value`, but nothing was ever watching it, so typing
 * into the node's own widget left the card showing the previous prompt.
 *
 * Deliberately independent of the panel. This is about the NODE being honest
 * about itself; the panel's two-way binding is modal/binding.js's business and
 * both can be installed at once — bind.js is idempotent per node and reference
 * counts its subscribers.
 *
 * KNOWN LIMIT, accepted on purpose: no timer is started here, so bind.js's
 * polling backstop does not run for the card on its own. On a frontend where
 * neither the element listener nor the value interception can be installed the
 * preview goes stale again until the panel is opened on this node —
 * modal/index.js's heartbeat drives the poll then, and the resulting event
 * reaches every subscriber including this one. A per-node interval running for
 * the lifetime of every graph is not worth a preview line.
 *
 * The import is lazy and guarded like every other cross-module reach in this
 * feature: a missing bind.js costs a stale preview line, nothing more.
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
        "web/prompt_librarian/node/bind.js is not available; the node card will not track edits made in the node's own text widget",
        err && err.message
      );
    });
}

/**
 * Pull the record's name/rating/used from the backend for the node face.
 *
 * Lazily imported and guarded: with no backend the face simply shows what the
 * local widgets already know — a complete, usable node, just without stars and
 * a usage count.
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
