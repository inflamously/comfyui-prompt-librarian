/* ==========================================================================
   The fake ComfyUI `api` object.

   Only `fetchApi` matters: it is the pack's single network call site. Every
   request is logged to the harness network panel, which is the only sane way to
   evaluate api/lanes.js supersede-and-abort behaviour — you need to see the
   request that was cancelled.
   ========================================================================== */

const listeners = new Map();

/** How long a fake render "takes", so the generator's progress card is watchable. */
const RENDER_MS = 250;

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
      if (path === "/prompt" && method === "POST" && res.ok) void replayExecution(res.clone());
      return res;
    } catch (err) {
      row.aborted = err && err.name === "AbortError";
      row.status = row.aborted ? "abort" : "error";
      row.ms = Math.round(performance.now() - started);
      log(row);
      throw err;
    }
  },

  // ComfyUI's api is an EventTarget fed by its websocket. The word-picture
  // generator listens for execution events; replayExecution() sends them.
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

/**
 * Stand in for ComfyUI's websocket after a queued prompt. The dev server's
 * /prompt renders at once and returns the outputs under `__dev`; this sends
 * them as the events a real server would, `RENDER_MS` later.
 */
async function replayExecution(res) {
  let payload;
  try {
    payload = await res.json();
  } catch {
    return;
  }
  const { prompt_id, __dev } = payload || {};
  if (!prompt_id || !__dev) return;
  const emit = (type, detail) => api.dispatchEvent(new CustomEvent(type, { detail: { prompt_id, ...detail } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  emit("execution_start", {});
  await new Promise((resolve) => setTimeout(resolve, RENDER_MS));
  for (const [node, output] of Object.entries(__dev.outputs || {})) {
    emit("executing", { node });
    emit("executed", { node, output });
  }
  emit("execution_success", {});
  emit("executing", { node: null });
}
