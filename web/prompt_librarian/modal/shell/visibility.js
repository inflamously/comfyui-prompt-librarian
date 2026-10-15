import { inst } from "../instance.js";

/** Set visibility and aria-modal together. ComfyUI blocks shortcuts for any
 * [role="dialog"][aria-modal="true"], even when hidden.
 */
export function setModalVisible(visible) {
  const it = inst();
  const card = it.els && it.els.card;
  if (card) {
    if (visible) card.setAttribute("aria-modal", "true");
    else card.removeAttribute("aria-modal");
  }
  if (it.root) it.root.hidden = !visible;
}
