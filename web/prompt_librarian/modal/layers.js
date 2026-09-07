/* Layers and toasts are siblings of .pl-card, outside its layout/paint containment,
 * so fixed-position popovers use viewport coordinates.
 */

import { NS } from "../shared/ns.js";
import { h } from "../shared/dom.js";
import { focusables } from "./keys.js";
import { inst } from "./state.js";

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


/** Use a toast instead of a blocking browser dialog.
 *
 * @param {string} message
 * @param {{kind?: "info"|"success"|"error"|"warn", ms?: number}} [opts]
 */
export function toast(message, opts = {}) {
  const it = inst();
  const kind = opts.kind || "info";
  const ms = typeof opts.ms === "number" ? opts.ms : 4000;
  if (!it.built || !it.els.toasts) {
    console.info(`${NS} ${kind}: ${message}`);
    return null;
  }
  const el = h(
    "div",
    {
      className: "pl-toast" + (kind === "error" ? " is-error" : kind === "warn" ? " is-warn" : ""),
      role: "status",
      "aria-live": kind === "error" ? "assertive" : "polite",
    },
    String(message == null ? "" : message)
  );
  it.els.toasts.appendChild(el);
  const kill = () => {
    if (!el.parentNode) return;
    el.classList.add("is-out");
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  };
  if (ms > 0) setTimeout(kill, ms);
  el.addEventListener("click", kill);
  return el;
}

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
