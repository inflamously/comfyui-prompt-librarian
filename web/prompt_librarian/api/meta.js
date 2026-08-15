/* ==========================================================================
   Prompt Librarian — batched record metadata (node faces)
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { singleton } from "../shared/singleton.js";
import { API } from "./routes.js";

function metaState() {
  return singleton("meta", () => ({
    cache: new Map(), // id -> meta|null    (null = "asked, does not exist")
    waiting: new Map(), // id -> {promise, resolve}
    queued: new Set(),
    scheduled: false,
  }));
}

/**
 * Normalise whatever shape `POST /meta` answers with into `{id: meta}`.
 * Written defensively on purpose: this is the one response shape the frontend
 * consumes before the backend agent's file exists, and a mismatch here would
 * silently blank every node face rather than throw.
 */
function indexMetas(payload) {
  const out = new Map();
  if (!payload || typeof payload !== "object") return out;
  const bag = payload.meta || payload.metas || payload.items || payload.prompts || payload;
  if (Array.isArray(bag)) {
    for (const m of bag) if (m && m.id) out.set(String(m.id), m);
  } else if (bag && typeof bag === "object") {
    for (const key of Object.keys(bag)) {
      const m = bag[key];
      if (m && typeof m === "object" && !Array.isArray(m)) out.set(String(key), m);
    }
  }
  return out;
}

async function flushMeta() {
  const st = metaState();
  st.scheduled = false;
  const ids = Array.from(st.queued);
  st.queued.clear();
  if (!ids.length) return;

  let found = new Map();
  let failed = null;
  try {
    found = indexMetas(await API.meta(ids));
  } catch (err) {
    failed = err;
  }

  for (const id of ids) {
    const entry = st.waiting.get(id);
    st.waiting.delete(id);
    if (failed) {
      // Do NOT cache a failure: a backend that is not up yet must not poison
      // every future lookup for the life of the page.
      if (entry) entry.resolve(null);
      continue;
    }
    const meta = found.has(id) ? found.get(id) : null;
    st.cache.set(id, meta);
    if (entry) entry.resolve(meta);
  }

  if (failed && typeof console !== "undefined") {
    console.debug(`${NS} meta batch failed`, failed && failed.message);
  }
}

/**
 * Metadata for one record, batched and cached.
 *
 * Every call made in the same microtask joins ONE `POST /meta {ids:[…]}`, so
 * ten Librarian nodes on a canvas produce one request rather than ten. The
 * result is cached until `invalidateMeta` clears it; a lookup that fails
 * resolves `null` and is not cached.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export function getPromptMeta(id) {
  const key = String(id || "").trim();
  if (!key) return Promise.resolve(null);
  const st = metaState();
  if (st.cache.has(key)) return Promise.resolve(st.cache.get(key));

  let entry = st.waiting.get(key);
  if (!entry) {
    entry = {};
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    st.waiting.set(key, entry);
    st.queued.add(key);
  }
  if (!st.scheduled) {
    st.scheduled = true;
    // Microtask, not setTimeout: the batch closes at the end of the current
    // job, so a burst of nodeCreated callbacks in one tick shares a request
    // without adding a frame of latency.
    Promise.resolve().then(flushMeta);
  }
  return entry.promise;
}

/**
 * Alias kept for the node face, which calls `api.fetchMeta(id)`. Same
 * batching, same cache.
 */
export const fetchMeta = getPromptMeta;

/**
 * Drop cached metadata so the next lookup re-fetches.
 * @param {Iterable<string>|string|null} [ids] omit to clear everything
 */
export function invalidateMeta(ids) {
  const st = metaState();
  if (ids == null) {
    st.cache.clear();
    return;
  }
  const list = typeof ids === "string" ? [ids] : Array.from(ids || []);
  for (const id of list) st.cache.delete(String(id));
}
