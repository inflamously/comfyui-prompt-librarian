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
 *
 * Every layer gets its own scrim appended just before it, so whatever is
 * underneath — the card, and any layer already on the stack — cannot register
 * clicks while this one is up. A closeOnOutside layer is still dismissed by a
 * click on its scrim (the pointerdown handler in modal/shell.js), but the
 * click stops there instead of also pressing a button on the card behind it.
 * Pass `scrim: false` for a layer that must let the page beneath it stay live.
 *
 * The scrim of a dialog (closeOnOutside:false) is tinted, so the layer beneath
 * visibly recedes; a popover's is clear. `dim` forces either way.
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
    if (target.scrim && target.scrim.parentNode) target.scrim.parentNode.removeChild(target.scrim);
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
 * Dialog with an arbitrary set of answers, rendered into the layer stack.
 *
 * `confirmDialog` is the two-answer special case and is written in terms of
 * this one, so both look and behave identically — a three-way question ("save,
 * discard, or stay?") must not read like a different piece of software.
 *
 * Deliberately self-contained: `compare/` offers richer flows, but the modal
 * must never depend on a module that may not be there.
 *
 * The buttons are laid out cancel-first, matching the two-button dialog. The
 * dismissal answer (Escape, onClose, an unbuilt modal) is ALWAYS `cancelValue`
 * — never the first choice — because every caller treats "the dialog went away
 * without an answer" as "change nothing".
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
