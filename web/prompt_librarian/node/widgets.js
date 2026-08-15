/* ==========================================================================
   Prompt Librarian — LiteGraph widget lookup for the PromptLibrarian node
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   The node's widget names live here, in one place, because three features
   (the face, the binding and the hydration) all reach for the same two.
   ========================================================================== */

import { warnOnce } from "../shared/singleton.js";

/** The widget carrying the prompt body. Also the node's output. */
export const TEXT_WIDGET = "text";

/** The widget carrying the library record link. Hidden below. */
export const ID_WIDGET = "prompt_id";

/** Guarded lookup — `node.widgets` may not exist yet during graph init. */
export function findWidget(node, name) {
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
export function hidePromptIdWidget(node) {
  const w = findWidget(node, ID_WIDGET);
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
export function setWidgetLabel(w, text) {
  if (!w) return;
  w.name = text;
  w.label = text;
}
