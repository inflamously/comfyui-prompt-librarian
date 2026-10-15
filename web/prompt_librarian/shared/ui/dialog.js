/* Modal choice dialogs on a LayerStack: a title, a message, a cancel button and
 * any number of choices. choose() resolves with the picked value, or with
 * cancelValue when the dialog is dismissed any other way.
 */

import { Component } from "../component.js";
import { h } from "../dom.js";

/**
 * @typedef {object} Choice
 * @property {any} value
 * @property {string} label
 * @property {boolean} [danger]
 * @property {boolean} [primary]
 */

/**
 * deps: {title?, message?, cancelLabel?, cancelValue?, choices?: Choice[],
 * onChoose(value)}. Every button calls onChoose; closing is the caller's job.
 */
export class ChoiceDialog extends Component {
  render() {
    const { title = "Are you sure?", message = "", cancelLabel = "Cancel" } = this.deps;
    const { cancelValue = null, choices = [], onChoose } = this.deps;
    const button = (label, value, kind = "") =>
      h("button", { className: "pl-btn pl-btn-sm" + kind, type: "button", onclick: () => onChoose(value) }, label);

    const body = h("div", { className: "pl-dialog-body" });
    for (const line of String(message ?? "").split("\n")) body.append(h("div", null, line));
    const acts = h("div", { className: "pl-dialog-acts" });
    if (cancelLabel) acts.append(button(cancelLabel, cancelValue));
    for (const c of choices) {
      if (c) acts.append(button(c.label, c.value, c.danger ? " pl-btn-danger" : c.primary ? " pl-btn-primary" : ""));
    }
    return h(
      "div",
      { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { className: "pl-dialog-title" }, title),
      body,
      acts,
    );
  }
}

/**
 * Open a ChoiceDialog on `layers`; resolves once, with the choice or cancelValue.
 * @param {import("./layer-stack.js").LayerStack|null} layers
 * @returns {Promise<any>}
 */
export function choose(layers, opts = {}) {
  const cancelValue = opts.cancelValue ?? null;
  if (!layers) return Promise.resolve(cancelValue);
  return new Promise((resolve) => {
    let done = false;
    let layer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      layers.pop(layer); // its onClose re-enters finish, which is now a no-op
      resolve(value);
    };
    layer = layers.push({
      component: new ChoiceDialog({ ...opts, onChoose: finish }),
      closeOnOutside: false,
      onClose: () => finish(cancelValue),
    });
  });
}

/** A yes/no choose(): resolves true only when the confirm button is picked. */
export async function confirm(layers, { confirmLabel = "Confirm", danger = false, ...opts } = {}) {
  const choices = [{ value: true, label: confirmLabel, danger, primary: !danger }];
  return !!(await choose(layers, { ...opts, cancelValue: false, choices }));
}
