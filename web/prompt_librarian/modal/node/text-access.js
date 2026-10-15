/* Read access to a node's `text` and `prompt_id` widgets: the backing element,
 * both raw values, and the body as the user currently sees it. text-sync.js
 * explains why the element and the widget value can disagree.
 */

import { ID_WIDGET, TEXT_WIDGET, findWidget } from "./widgets.js";

/** Return the backing textarea, including wrapped DOM widgets, or null for
 * frontends without one.
 */
export function widgetElement(w) {
  if (!w) return null;
  try {
    const cand = [w.inputEl, w.element, w.el, w.domElement];
    for (const c of cand) {
      if (!c || typeof c !== "object") continue;
      if (typeof c.value === "string" && typeof c.addEventListener === "function") return c;
      if (typeof c.querySelector === "function") {
        const inner = c.querySelector("textarea, input");
        if (inner) return inner;
      }
    }
  } catch (_) {
    /* an exotic widget that throws on property access is simply elementless */
  }
  return null;
}

/** Programmatic .value assignment does not fire input; notify mirror/autosize
 * listeners explicitly. Keep this helper independent of pickers/.
 */
export function dispatchInput(el) {
  if (!el || typeof el.dispatchEvent !== "function") return;
  try {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (_) {
    try {
      const ev = document.createEvent("Event");
      ev.initEvent("input", true, false);
      el.dispatchEvent(ev);
    } catch (__) {
      /* nothing more we can do; the value is still set */
    }
  }
}

/** A widget value as a string; null and undefined read as empty. */
export function str(v) {
  return v == null ? "" : String(v);
}

/** The textarea may be ahead of widget.value until blur. Keep both sources
 * separate; null means absent, while an empty string is a valid value.
 *
 * @returns {{el: string|null, widget: string|null}}
 */
export function rawValues(textW) {
  const el = widgetElement(textW);
  return {
    el: el && typeof el.value === "string" ? str(el.value) : null,
    widget: textW ? str(textW.value) : null,
  };
}

/** Prefer the backing element because some frontends sync widget.value only on blur.
 *
 * @returns {{body: string, id: string} | null} null when the widgets are not
 *   wired yet (nodeCreated fires before ComfyUI applies serialized values).
 */
export function readNodeText(node) {
  const textW = findWidget(node, TEXT_WIDGET);
  if (!textW) return null;
  const idW = findWidget(node, ID_WIDGET);
  const raw = rawValues(textW);
  return {
    body: raw.el !== null ? raw.el : str(raw.widget),
    id: str(idW ? idW.value : ""),
  };
}
