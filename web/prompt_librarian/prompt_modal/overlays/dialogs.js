import { h } from "../../shared/dom.js";
import { inst } from "../state.js";
import { pushLayer, popLayer } from "./layers.js";

/** Build locally so choices remain available when optional picker/dialog modules fail.
 *
 * @param {{
 *   title?: string, message?: string, cancelLabel?: string, cancelValue?: any,
 *   choices?: Array<{value: any, label: string, danger?: boolean, primary?: boolean}>
 * }} [opts]
 * @returns {Promise<any>} the chosen `value`, or `cancelValue` on dismissal
 */
export function choiceDialog({
  title = "Are you sure?",
  message = "",
  cancelLabel = "Cancel",
  cancelValue = null,
  choices = [],
} = {}) {
  const it = inst();
  if (!it.built) return Promise.resolve(cancelValue);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      popLayer(handle);
      resolve(val);
    };
    const body = h("div", { className: "pl-dialog-body" });
    const lines = String(message == null ? "" : message).split("\n");
    for (const line of lines) body.appendChild(h("div", null, line));

    const acts = h("div", { className: "pl-dialog-acts" });
    if (cancelLabel) {
      acts.appendChild(
        h(
          "button",
          { className: "pl-btn pl-btn-sm", type: "button", onclick: () => finish(cancelValue) },
          cancelLabel
        )
      );
    }
    for (const c of choices) {
      if (!c) continue;
      const kind = c.danger ? " pl-btn-danger" : c.primary ? " pl-btn-primary" : "";
      acts.appendChild(
        h(
          "button",
          { className: "pl-btn pl-btn-sm" + kind, type: "button", onclick: () => finish(c.value) },
          c.label
        )
      );
    }

    const el = h(
      "div",
      { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { className: "pl-dialog-title" }, title),
      body,
      acts
    );
    const handle = pushLayer({ el, closeOnOutside: false, onClose: () => finish(cancelValue) });
    if (!handle) {
      resolve(cancelValue);
      return;
    }
  });
}

/**
 * Basic confirm dialog rendered into the layer stack.
 *
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = "Are you sure?",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  return choiceDialog({
    title,
    message,
    cancelLabel,
    cancelValue: false,
    choices: [{ value: true, label: confirmLabel, danger, primary: !danger }],
  }).then((v) => !!v);
}
