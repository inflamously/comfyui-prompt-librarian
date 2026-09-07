/* Layers and toasts are siblings of .pl-card, outside its layout/paint containment,
 * so fixed-position popovers use viewport coordinates.
 */

import { NS } from "../../shared/ns.js";
import { h } from "../../shared/dom.js";
import { focusables } from "../input/focus.js";
import { inst } from "../state.js";

/** Give every layer its own preceding scrim so clicks cannot reach layers
 * underneath. Popover scrims block clicks without dimming.
 *
 * @param {{el: HTMLElement, onClose?: () => void, closeOnOutside?: boolean, scrim?: boolean, dim?: boolean}} opts
 * @returns {object} handle for popLayer()
 */
export function pushLayer(opts) {
  const it = inst();
  if (!it.built || !opts || !opts.el) return null;
  const handle = {
    el: opts.el,
    onClose: typeof opts.onClose === "function" ? opts.onClose : null,
    closeOnOutside: opts.closeOnOutside !== false,
    scrim: null,
    restoreFocus: typeof document !== "undefined" ? document.activeElement : null,
  };
  it.layers.push(handle);
  if (opts.scrim !== false) {
    // Dialogs tint what they cover; popovers only block it. `dim` overrides
    // that default either way.
    const dim = typeof opts.dim === "boolean" ? opts.dim : !handle.closeOnOutside;
    handle.scrim = h("div", { className: "pl-layer-scrim" + (dim ? " is-dim" : "") });
    it.els.layers.appendChild(handle.scrim);
  }
  it.els.layers.appendChild(opts.el);
  const first = focusables(opts.el)[0];
  if (first) {
    try {
      first.focus();
    } catch (_) {
    }
  }
  return handle;
}

export function popLayer(handle) {
  const it = inst();
  const target = handle || it.layers[it.layers.length - 1];
  if (!target) return;
  const i = it.layers.indexOf(target);
  if (i < 0) return;
  it.layers.splice(i, 1);
  try {
    if (target.el && target.el.parentNode) target.el.parentNode.removeChild(target.el);
    if (target.scrim && target.scrim.parentNode) target.scrim.parentNode.removeChild(target.scrim);
  } catch (_) {
  }
  if (target.onClose) {
    try {
      target.onClose();
    } catch (err) {
      console.error(`${NS} layer onClose failed`, err);
    }
  }
  const back = target.restoreFocus;
  if (back && typeof back.focus === "function" && it.root && it.root.contains(back)) {
    try {
      back.focus();
    } catch (_) {
    }
  }
}

export function topLayer() {
  const it = inst();
  return it.layers[it.layers.length - 1] || null;
}


