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

/** Accept supported /meta envelope shapes and return {id: meta}.
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

/** Coalesce same-microtask lookups into one request. Cache missing records,
 * but do not cache failures; those must remain retryable.
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
    // A microtask batches nodeCreated callbacks without adding frame latency.
    Promise.resolve().then(flushMeta);
  }
  return entry.promise;
}

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
