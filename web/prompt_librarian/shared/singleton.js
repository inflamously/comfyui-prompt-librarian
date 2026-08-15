/* ==========================================================================
   Prompt Librarian — cross-module singleton
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   No build step. Vanilla ES module, served raw.
   ========================================================================== */

import { NS } from "./ns.js";

const GLOBAL_KEY = "__PROMPT_LIBRARIAN__";

/**
 * Get-or-create a process-wide singleton, stored on `window`.
 *
 * MODULE SCOPE IS NOT A SAFE SINGLETON HERE. ComfyUI cache-busts extension
 * module URLs with a `?v=…` query, and the module registry is keyed on the
 * FULL url — so `modal/index.js?v=1` and `modal/index.js?v=2` (or the
 * extension scanner's copy versus an `import()` of ours) are two separate
 * module instances with two separate sets of module-level `let`s. A
 * `let modalRoot` would then produce two modals, two keydown guards and two
 * toast stacks. Anything that must be unique on the page — the modal root, the
 * meta cache, the request lanes, the host injection — goes through here
 * instead.
 *
 * @template T
 * @param {string} key
 * @param {() => T} factory called at most once per key
 * @returns {T}
 */
export function singleton(key, factory) {
  const g = typeof window !== "undefined" ? window : globalThis;
  let bag = g[GLOBAL_KEY];
  if (!bag || typeof bag !== "object") {
    bag = Object.create(null);
    g[GLOBAL_KEY] = bag;
  }
  if (!(key in bag)) bag[key] = factory();
  return bag[key];
}

/**
 * Read the singleton bag without creating an entry. Useful for teardown paths
 * that must not resurrect what they are tearing down.
 * @returns {object}
 */
export function singletonBag() {
  const g = typeof window !== "undefined" ? window : globalThis;
  if (!g[GLOBAL_KEY] || typeof g[GLOBAL_KEY] !== "object") g[GLOBAL_KEY] = Object.create(null);
  return g[GLOBAL_KEY];
}

/**
 * Log a message at most once per key, for the "your frontend lacks X" class of
 * warning that would otherwise fire on every node or every keystroke.
 * @param {string} key
 * @param {...any} args
 */
export function warnOnce(key, ...args) {
  const seen = singleton("warnOnce", () => new Set());
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(NS, ...args);
}
