/* A stack of overlays (dialogs, popovers) inside one host element. Every layer
 * gets its own scrim just before it, so DOM order alone keeps clicks from
 * reaching anything underneath. The host must sit outside any element with
 * layout or paint containment, or fixed-position popovers end up offset.
 */

import { NS } from "../ns.js";
import { focusables, h } from "../dom.js";

/**
 * @typedef {object} Layer
 * @property {HTMLElement} el
 * @property {boolean} closeOnOutside
 */

export class LayerStack {
  /**
   * @param {HTMLElement} host where layers are appended
   * @param {{root?: HTMLElement}} [opts] focus returns on pop only to elements inside root
   */
  constructor(host, { root = host } = {}) {
    this.host = host;
    this.root = root;
    this._layers = [];
  }

  /** How many layers are open. */
  get size() {
    return this._layers.length;
  }

  /** The topmost layer, or null. */
  top() {
    return this._layers[this._layers.length - 1] || null;
  }

  /**
   * Open a layer from an element or a Component, and focus its first control.
   * Dialogs (closeOnOutside false) dim what they cover; popovers only block it.
   * @param {{el?: HTMLElement, component?: object, onClose?: () => void,
   *          closeOnOutside?: boolean, scrim?: boolean, dim?: boolean}} opts
   * @returns {Layer} the handle for pop()
   */
  push({ el, component, onClose, closeOnOutside = true, scrim = true, dim } = {}) {
    const layer = {
      el: el || null,
      component: component || null,
      onClose: typeof onClose === "function" ? onClose : null,
      closeOnOutside,
      scrim: null,
      restoreFocus: this.host.ownerDocument.activeElement,
    };
    this._layers.push(layer);
    if (scrim) {
      const tint = typeof dim === "boolean" ? dim : !closeOnOutside;
      layer.scrim = h("div", { className: "pl-layer-scrim" + (tint ? " is-dim" : "") });
      this.host.append(layer.scrim);
    }
    if (layer.component) layer.el = layer.component.mount(this.host).el;
    else this.host.append(layer.el);
    focusables(layer.el)[0]?.focus();
    return layer;
  }

  /** Close `layer` (default: the top one); closing a closed layer does nothing. */
  pop(layer = this.top()) {
    const i = this._layers.indexOf(layer);
    if (i < 0) return;
    this._layers.splice(i, 1);
    if (layer.component) layer.component.destroy();
    layer.el?.remove();
    layer.scrim?.remove();
    if (layer.onClose) {
      try {
        layer.onClose();
      } catch (err) {
        console.error(`${NS} layer onClose failed`, err);
      }
    }
    const back = layer.restoreFocus;
    if (back && typeof back.focus === "function" && this.root.contains(back)) back.focus();
  }

  /** Close every layer, topmost first. */
  clear() {
    while (this._layers.length) this.pop();
  }
}
