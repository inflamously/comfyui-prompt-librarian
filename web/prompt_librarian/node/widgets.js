import { warnOnce } from "../shared/singleton.js";

export const TEXT_WIDGET = "text";

export const ID_WIDGET = "prompt_id";

export function findWidget(node, name) {
  const list = node && node.widgets;
  if (!Array.isArray(list)) return null;
  return list.find((w) => w && w.name === name) || null;
}

/** Keep prompt_id in node.widgets so it serializes. Hide its row; [0, -4]
 * cancels the inter-widget margin on frontends that still reserve space.
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

/** Assign both name and label because LiteGraph versions choose differently.
 */
export function setWidgetLabel(w, text) {
  if (!w) return;
  w.name = text;
  w.label = text;
}
