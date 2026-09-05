import { NS } from "./ns.js";

const GLOBAL_KEY = "__PROMPT_LIBRARIAN__";

/** ComfyUI cache-busted URLs create separate module instances. Store page-wide
 * state on the shared window bag to avoid duplicate modals, guards, and caches.
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

/** Read without creating an entry, so teardown cannot resurrect state.
 *
 * @returns {object}
 */
export function singletonBag() {
  const g = typeof window !== "undefined" ? window : globalThis;
  if (!g[GLOBAL_KEY] || typeof g[GLOBAL_KEY] !== "object") g[GLOBAL_KEY] = Object.create(null);
  return g[GLOBAL_KEY];
}

/** Log once per key to avoid repeating compatibility warnings.
 *
 * @param {string} key
 * @param {...any} args
 */
export function warnOnce(key, ...args) {
  const seen = singleton("warnOnce", () => new Set());
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(NS, ...args);
}
