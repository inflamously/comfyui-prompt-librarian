/* ==========================================================================
   The fake ComfyUI `api` object.

   Only `fetchApi` matters: it is the pack's single network call site. Every
   request is logged to the harness network panel, which is the only sane way to
   evaluate api/lanes.js supersede-and-abort behaviour — you need to see the
   request that was cancelled.
   ========================================================================== */

const listeners = new Map();

/** Push a row into the harness network panel, if it is mounted. */
function log(row) {
  window.dispatchEvent(new CustomEvent("dev:net", { detail: row }));
}

export const api = {
  /** ComfyUI exposes this; some extensions use it to build URLs. */
  apiURL(path) {
    return window.__DEV__.apiPrefix + path;
  },

  async fetchApi(path, init = {}) {
    const url = window.__DEV__.apiPrefix + (path.startsWith("/") ? path : "/" + path);
    const method = (init.method || "GET").toUpperCase();
    const started = performance.now();
    const row = { method, url, status: 0, ms: 0, aborted: false };
    try {
      const res = await fetch(url, init);
      row.status = res.status;
      row.ms = Math.round(performance.now() - started);
      log(row);
      return res;
    } catch (err) {
      row.aborted = err && err.name === "AbortError";
      row.status = row.aborted ? "abort" : "error";
      row.ms = Math.round(performance.now() - started);
      log(row);
      throw err;
    }
  },

  // ComfyUI's api is an EventTarget. Nothing under web/ subscribes today (tier
  // 0 asserts fetchApi is the only network call site), but the surface exists
  // so a future listener does not crash the harness.
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  },
  dispatchEvent(ev) {
    const set = listeners.get(ev.type);
    if (set) for (const fn of Array.from(set)) fn(ev);
    return true;
  },
};
