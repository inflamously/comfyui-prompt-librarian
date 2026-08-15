/* ==========================================================================
   Prompt Librarian — the layer stack, toasts and the basic confirm
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   `.pl-layers` and `.pl-toasts` are children of `.pl-root` and SIBLINGS of
   `.pl-card` — see the note in modal/shell.js. That is what lets a popover be
   positioned from viewport coordinates.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { h } from "../shared/dom.js";
import { focusables } from "./keys.js";
import { inst } from "./state.js";

/**
 * Push a layer (popover, sub-dialog) onto `.pl-layers`.
 * @param {{el: HTMLElement, onClose?: () => void, closeOnOutside?: boolean}} opts
 * @returns {object} handle for popLayer()
 */
export function pushLayer(opts) {
  const it = inst();
  if (!it.built || !opts || !opts.el) return null;
  const handle = {
    el: opts.el,
    onClose: typeof opts.onClose === "function" ? opts.onClose : null,
    closeOnOutside: opts.closeOnOutside !== false,
    restoreFocus: typeof document !== "undefined" ? document.activeElement : null,
  };
  it.layers.push(handle);
  it.els.layers.appendChild(opts.el);
  const first = focusables(opts.el)[0];
  if (first) {
    try {
      first.focus();
    } catch (_) {
      /* ignore */
    }
  }
  return handle;
}

/** Remove a layer (default: the top one) and run its onClose. */
export function popLayer(handle) {
  const it = inst();
  const target = handle || it.layers[it.layers.length - 1];
  if (!target) return;
  const i = it.layers.indexOf(target);
  if (i < 0) return;
  it.layers.splice(i, 1);
  try {
    if (target.el && target.el.parentNode) target.el.parentNode.removeChild(target.el);
  } catch (_) {
    /* ignore */
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
      /* ignore */
    }
  }
}

export function topLayer() {
  const it = inst();
  return it.layers[it.layers.length - 1] || null;
}

/* --------------------------------------------------------------------------
   Toasts + confirm
   -------------------------------------------------------------------------- */

/**
 * Transient message. NEVER alert() — a modal browser dialog blocks ComfyUI's
 * canvas and its render loop.
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

/**
 * Basic confirm dialog rendered into the layer stack.
 *
 * Deliberately self-contained: `compare/` offers richer flows, but the modal
 * must never depend on a module that may not be there.
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
  const it = inst();
  if (!it.built) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      popLayer(handle);
      resolve(!!val);
    };
    const body = h("div", { className: "pl-dialog-body" });
    const lines = String(message == null ? "" : message).split("\n");
    for (const line of lines) body.appendChild(h("div", null, line));

    const el = h(
      "div",
      { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { className: "pl-dialog-title" }, title),
      body,
      h(
        "div",
        { className: "pl-dialog-acts" },
        h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => finish(false) }, cancelLabel),
        h(
          "button",
          {
            className: "pl-btn pl-btn-sm " + (danger ? "pl-btn-danger" : "pl-btn-primary"),
            type: "button",
            onclick: () => finish(true),
          },
          confirmLabel
        )
      )
    );
    const handle = pushLayer({ el, closeOnOutside: false, onClose: () => finish(false) });
    if (!handle) {
      resolve(false);
      return;
    }
  });
}
