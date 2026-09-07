import { NS } from "../../shared/ns.js";
import { h } from "../../shared/dom.js";
import { inst } from "../state.js";

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
  let timer = null;
  let removal = null;
  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(removal);
    el.removeEventListener("click", kill);
    el.remove();
    it.toastCleanup.delete(cleanup);
  };
  const kill = () => {
    if (!el.parentNode || removal !== null) return;
    el.classList.add("is-out");
    removal = setTimeout(cleanup, 220);
  };
  it.toastCleanup.add(cleanup);
  if (ms > 0) timer = setTimeout(kill, ms);
  el.addEventListener("click", kill);
  return el;
}

export function clearToasts() {
  for (const cleanup of inst().toastCleanup) cleanup();
}
