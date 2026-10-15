/* Short, non-blocking messages stacked in one host element; used instead of
 * browser alerts. A toast leaves after `ms` (0 keeps it) or when clicked.
 */

import { h } from "../dom.js";

const EXIT_MS = 220; // the length of the pl-toast-out animation

export class Toaster {
  /** @param {HTMLElement} host */
  constructor(host) {
    this.host = host;
    this._live = new Set(); // the cleanup of every toast still in the DOM
  }

  /** How many toasts are showing. */
  get size() {
    return this._live.size;
  }

  /**
   * Show `message`; errors are announced assertively, everything else politely.
   * @param {string} message
   * @param {{kind?: "info"|"success"|"error"|"warn", ms?: number}} [opts]
   * @returns {HTMLElement}
   */
  show(message, { kind = "info", ms = 4000 } = {}) {
    const el = h(
      "div",
      {
        className: "pl-toast" + (kind === "error" ? " is-error" : kind === "warn" ? " is-warn" : ""),
        role: "status",
        "aria-live": kind === "error" ? "assertive" : "polite",
      },
      String(message ?? ""),
    );
    this.host.append(el);
    let timer = null;
    let removal = null;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(removal);
      el.removeEventListener("click", leave);
      el.remove();
      this._live.delete(cleanup);
    };
    const leave = () => {
      if (!el.parentNode || removal !== null) return;
      el.classList.add("is-out");
      removal = setTimeout(cleanup, EXIT_MS);
    };
    this._live.add(cleanup);
    if (ms > 0) timer = setTimeout(leave, ms);
    el.addEventListener("click", leave);
    return el;
  }

  /** Remove every toast now, timers included. */
  clear() {
    for (const cleanup of this._live) cleanup();
  }
}
