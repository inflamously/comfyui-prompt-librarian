/* ==========================================================================
   Prompt Librarian — transport layer
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Nothing at module scope may do work: exports and `const` data only.

   This is the ONLY file under web/pl/ that imports from ComfyUI. The fragile
   relative path to the core tree exists here and in web/pl_librarian.js, and
   nowhere else — every other module talks to the backend through `API`.

   `api.fetchApi` is used rather than bare `fetch` because it prefixes
   ComfyUI's base URL (`/api`, plus any reverse-proxy prefix). A bare
   `fetch("/prompt_librarian/search")` works on a default install and 404s
   behind a proxy, which is exactly the kind of bug that only shows up on
   somebody else's machine.
   ========================================================================== */

import { api } from "../../../scripts/api.js";
import { NS, escapeQuery, singleton } from "./dom.js";

/** Route prefix. Every route is `/prompt_librarian/<name>`. */
export const BASE = "/prompt_librarian/";

/**
 * Returned by a lane's `run()` when the call was superseded or cancelled.
 * A cancellation is NOT an error: every call site would otherwise need a
 * try/catch whose only job is to swallow an AbortError, and the one that
 * forgets turns a keystroke into a red console trace.
 *
 *   const res = await lanes.search((signal) => API.search(params, signal));
 *   if (res === ABORTED) return;      // a newer search is already running
 */
export const ABORTED = Symbol("aborted");

/* --------------------------------------------------------------------------
   Errors
   -------------------------------------------------------------------------- */

/**
 * A backend (or transport) failure with the pieces the UI needs to explain
 * itself: the HTTP status, the parsed body when there was one, and the
 * backend's machine-readable `code` (`bad_request`, `not_found`, `too_large`,
 * `conflict`, `readonly`, `same_record`, `write_failed`, `internal`, plus the
 * transport-side `network`, `not_json` and `bad_json`).
 */
export class ApiError extends Error {
  constructor(status, body, code) {
    const detail =
      (body && typeof body === "object" && (body.error || body.message)) ||
      (typeof body === "string" && body.trim() ? body.trim().slice(0, 200) : "") ||
      "";
    super(detail || `request failed (${code || status || "error"})`);
    this.name = "ApiError";
    this.status = Number(status) || 0;
    this.body = body == null ? null : body;
    this.code = code || codeForStatus(this.status);
  }

  /** True when retrying could plausibly work (server hiccup, network drop). */
  get transient() {
    return this.status === 0 || this.status >= 500;
  }
}

function codeForStatus(status) {
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 413) return "too_large";
  if (status >= 500) return "internal";
  if (!status) return "network";
  return "http_" + status;
}

/** True for the DOMException an aborted fetch rejects with. */
function isAbort(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  // Safari/older engines: DOMException code 20 == ABORT_ERR.
  return err.code === 20 && typeof err.name === "string";
}

/* --------------------------------------------------------------------------
   req() — the single request primitive
   -------------------------------------------------------------------------- */

/**
 * Perform one request against the librarian routes.
 *
 * Two things here are load-bearing:
 *
 * 1. `Content-Type: application/json` is set ONLY when there is a body. Some
 *    aiohttp/proxy stacks treat a content-type on an empty GET as a malformed
 *    request, and it is meaningless anyway.
 * 2. The response's content-type is CHECKED before parsing. If the backend
 *    routes were never registered (an import error in
 *    `prompt_librarian/api.py`, a ComfyUI version whose route table differs)
 *    the server answers with an HTML 404 page. `res.json()` on that throws a
 *    SyntaxError with a message about "<" — an unreadable error for the most
 *    likely real-world failure.
 *    A non-JSON response therefore becomes a clean ApiError with code
 *    `not_json`, which the modal renders as "the librarian backend is not
 *    responding".
 *
 * @param {string} path route name, appended to BASE
 * @param {{method?: string, body?: any, signal?: AbortSignal, query?: object}} [opts]
 * @returns {Promise<any>} the parsed JSON body
 */
async function req(path, opts = {}) {
  const method = opts.method || "GET";
  const init = { method };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "Content-Type": "application/json" };
  }
  if (opts.signal) init.signal = opts.signal;

  const url = BASE + path + (opts.query ? escapeQuery(opts.query) : "");

  let res;
  try {
    res = await api.fetchApi(url, init);
  } catch (err) {
    // An abort must propagate untouched so the lane can recognise it.
    if (isAbort(err)) throw err;
    throw new ApiError(0, { error: String((err && err.message) || err) }, "network");
  }

  const ctype = String((res.headers && res.headers.get && res.headers.get("content-type")) || "");
  const isJson = /\bjson\b/i.test(ctype);

  let payload = null;
  if (isJson) {
    try {
      payload = await res.json();
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new ApiError(res.status, null, "bad_json");
    }
  } else {
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      if (isAbort(err)) throw err;
    }
    if (!res.ok) throw new ApiError(res.status, text, codeForStatus(res.status));
    throw new ApiError(
      res.status,
      text,
      "not_json"
    );
  }

  if (!res.ok) {
    throw new ApiError(res.status, payload, (payload && payload.code) || codeForStatus(res.status));
  }
  // The guard in prompt_librarian/api.py answers errors with a non-2xx status,
  // but a handler that returns 200 with {error, code} must not be mistaken for
  // data.
  if (payload && typeof payload === "object" && payload.code && payload.error) {
    throw new ApiError(res.status, payload, payload.code);
  }
  return payload;
}

/* --------------------------------------------------------------------------
   Request lanes
   -------------------------------------------------------------------------- */

/**
 * Create an independent request lane.
 *
 *   const res = await lanes.search((signal) => API.search(params, signal));
 *   if (res === ABORTED) return;
 *
 * A lane serialises one *logical* stream of work: starting a new run
 * supersedes the previous one. It uses BOTH mechanisms, deliberately:
 *
 *  - an `AbortController`, so the superseded request stops occupying a
 *    connection and the backend can stop caring about it; and
 *  - a monotonic sequence number, because abort is not synchronous with
 *    resolution. A response that already resolved (or a promise that never
 *    honoured the signal at all — `API.meta` batching, a cached value, a
 *    non-fetch promise) would otherwise land *after* the newer one and
 *    overwrite fresh state with stale data. That race is the classic
 *    "type fast, get the results for the previous keystroke" bug, and abort
 *    alone does not close it.
 *
 * Lanes are independent so a 900 ms all-pairs dupe scan never cancels the
 * search the user is typing.
 *
 * @param {string} name for diagnostics
 * @returns {((fn: (signal: AbortSignal|undefined) => any) => Promise<any>) & {cancel: () => void, busy: () => boolean, laneName: string}}
 */
export function createLane(name) {
  let seq = 0;
  let ctrl = null;
  let inflight = 0;

  async function run(fn) {
    const mine = ++seq;
    if (ctrl) {
      try {
        ctrl.abort();
      } catch (_) {
        /* an already-aborted controller throws in some engines */
      }
    }
    ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const mineCtrl = ctrl;
    inflight++;
    try {
      const out = await fn(mineCtrl ? mineCtrl.signal : undefined);
      // Sequence guard: a newer run started while we were awaiting. Its result
      // is the truth; ours must not reach the caller.
      if (mine !== seq) return ABORTED;
      return out;
    } catch (err) {
      if (mine !== seq || isAbort(err)) return ABORTED;
      throw err;
    } finally {
      inflight--;
      if (mine === seq && ctrl === mineCtrl) ctrl = null;
    }
  }

  /** Abort the in-flight run and make its result unusable. */
  run.cancel = () => {
    seq++;
    if (ctrl) {
      try {
        ctrl.abort();
      } catch (_) {
        /* ignore */
      }
    }
    ctrl = null;
  };
  run.busy = () => inflight > 0;
  run.laneName = String(name || "lane");
  return run;
}

/**
 * The lanes the panel uses. Stored on the shared singleton bag: ComfyUI
 * cache-busts extension module URLs, so two copies of this module can exist
 * on one page, and two sets of lanes would not cancel each other.
 */
export const lanes = singleton("lanes", () => ({
  search: createLane("search"),
  dupe: createLane("dupe"),
  record: createLane("record"),
  preview: createLane("preview"),
  versions: createLane("versions"),
  diff: createLane("diff"),
  taxonomy: createLane("taxonomy"),
}));

/** Abort every lane. Called from the modal's teardown list. */
export function cancelAllLanes() {
  for (const key of Object.keys(lanes)) {
    try {
      lanes[key].cancel();
    } catch (_) {
      /* ignore */
    }
  }
}

/* --------------------------------------------------------------------------
   Capabilities
   -------------------------------------------------------------------------- */

/**
 * Backend capability flags, filled in by `ping()`.
 *
 * Every known key starts `true` and is only turned off by a ping that says so.
 * Optimistic-by-default matters: if `/ping` itself fails (old backend, route
 * registration skipped) we must not disable the entire UI — the individual
 * calls will fail with an ApiError the user can actually read, which is far
 * more diagnosable than a panel full of greyed-out buttons.
 */
export const caps = singleton("caps", () => ({
  search: true,
  dupes: true,
  compare: true,
  merge: true,
  versions: true,
  bulk: true,
  taxonomy: true,
  wildcards: true,
  snippets: true,
  resolve: true,
  rate: true,
  usage: true,
  category: true,
  import_export: true,
}));

/** `false` only when the backend explicitly said so. */
export function capable(name) {
  return caps[name] !== false;
}

function applyCaps(payload) {
  const src =
    payload && typeof payload === "object"
      ? payload.capabilities || payload.caps || null
      : null;
  if (!src || typeof src !== "object") return caps;
  for (const key of Object.keys(src)) caps[key] = !!src[key];
  return caps;
}

/* --------------------------------------------------------------------------
   API surface
   --------------------------------------------------------------------------
   Every read is GET, every write is POST — no PATCH/DELETE verbs and no path
   parameters, matching prompt_librarian/api.py and staying compatible with
   ComfyUI's /api prefix rewriting.

   `sel` for the bulk operations is `{ids: [...]}` OR `{query: {...}}` and is
   spread through VERBATIM. The backend accepts both, and `{query}` is the only
   shape that scales to "select all 1 284 filtered".
   -------------------------------------------------------------------------- */

export const API = {
  /* -- reads -------------------------------------------------------------- */

  /** Liveness + capability probe. Also the cheapest "is the backend there?". */
  async ping(signal) {
    const data = await req("ping", { signal });
    applyCaps(data);
    return data;
  },

  /**
   * @param {object} params {q, category, tags[], dupes_only, sort, offset,
   *                         limit, threshold, match_id}
   */
  search(params, signal) {
    return req("search", { query: params || {}, signal });
  },

  get(id, signal) {
    return req("prompt", { query: { id }, signal });
  },

  /** Batch metadata for node faces. Prefer `getPromptMeta` — it coalesces. */
  meta(ids) {
    return req("meta", { method: "POST", body: { ids: Array.from(ids || []) } });
  },

  taxonomy(signal) {
    return req("taxonomy", { signal });
  },

  versions(id, signal) {
    return req("versions", { query: { id }, signal });
  },

  version(id, index, signal) {
    return req("version", { query: { id, index }, signal });
  },

  dupesAll(threshold, signal) {
    return req("dupes/all", { query: { threshold }, signal });
  },

  wildcards() {
    return req("wildcards");
  },

  snippets() {
    return req("snippets");
  },

  exportRaw() {
    return req("export");
  },

  /* -- writes ------------------------------------------------------------- */

  create(rec) {
    return req("create", { method: "POST", body: rec });
  },

  /** `rec.expect_updated` carries the optimistic-concurrency stamp. */
  update(rec) {
    return req("update", { method: "POST", body: rec });
  },

  del(id) {
    return req("delete", { method: "POST", body: { id } });
  },

  bulkDelete(sel) {
    return req("bulk/delete", { method: "POST", body: { ...sel } });
  },

  bulkRetag(sel, add, remove) {
    return req("bulk/retag", {
      method: "POST",
      body: { ...sel, add: add || [], remove: remove || [] },
    });
  },

  bulkCategorize(sel, category) {
    return req("bulk/categorize", { method: "POST", body: { ...sel, category } });
  },

  bulkMerge(sel, winner) {
    // `winner` is the backend's key, `winner_id` the contract's. Send both.
    return req("bulk/merge", { method: "POST", body: { ...sel, winner, winner_id: winner } });
  },

  rate(id, rating) {
    return req("rate", { method: "POST", body: { id, rating } });
  },

  usage(id, body) {
    return req("usage", { method: "POST", body: { id, ...(body || {}) } });
  },

  /**
   * The hot path — fired debounced on every edit. `exclude_id` is required
   * when editing an existing record or it reports itself at 100 %.
   * `summaries:false` skips the word-diff summary for the on-edit call.
   */
  dupes({ body, text, id, exclude_id, threshold, limit, summaries } = {}, signal) {
    const probe = text !== undefined ? text : body;
    return req("dupes", {
      method: "POST",
      // `text` is what prompt_librarian/api.py reads; `body` is the name in the
      // frozen frontend contract. Both are sent — an unknown key is ignored by
      // the handler, and a rename on either side cannot break the hot path.
      body: { text: probe, body: probe, id, exclude_id, threshold, limit, summaries },
      signal,
    });
  },

  ignorePair(a, b) {
    return req("dupes/ignore", { method: "POST", body: { a, b } });
  },

  compare({ a_id, a_text, b_id, b_text } = {}, signal) {
    return req("compare", { method: "POST", body: { a_id, a_text, b_id, b_text }, signal });
  },

  merge({ winner_id, loser_id, body, name } = {}) {
    return req("merge", {
      method: "POST",
      body: { winner: winner_id, loser: loser_id, winner_id, loser_id, body, name },
    });
  },

  mergeNew({ a_id, b_id, body, name, category, tags } = {}) {
    return req("merge_new", {
      method: "POST",
      body: { a: a_id, b: b_id, a_id, b_id, body, name, category, tags },
    });
  },

  restoreVersion(id, index) {
    return req("versions/restore", { method: "POST", body: { id, index } });
  },

  resolve({ text, seed, n } = {}, signal) {
    return req("resolve", { method: "POST", body: { text, seed, n }, signal });
  },

  setSnippet(name, body) {
    return req("snippet", { method: "POST", body: { op: "set", name, body } });
  },

  delSnippet(name) {
    return req("snippet", { method: "POST", body: { op: "delete", name } });
  },

  /**
   * Category maintenance. `op` is passed verbatim; the backend's shapes are
   *   {op:"add",    name}
   *   {op:"rename", name, new: "newName"}
   *   {op:"delete", name, reassign_to: "otherCategory"}
   */
  category(op) {
    return req("category", { method: "POST", body: { ...(op || {}) } });
  },

  /** Panel-level settings (dupe threshold, version cap). */
  settings(patch) {
    return req("settings", { method: "POST", body: { ...(patch || {}) } });
  },

  /**
   * @param {any} data the exported library object
   * @param {"replace"|"merge"} [mode] default "replace"
   */
  importRaw(data, mode) {
    const replace = mode !== "merge";
    return req("import", { method: "POST", body: { library: data, data, mode, replace } });
  },
};

/* --------------------------------------------------------------------------
   Batched record metadata (node faces)
   -------------------------------------------------------------------------- */

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
 * Alias kept for `web/pl_librarian.js`, which calls `api.fetchMeta(id)` for
 * the node face. Same batching, same cache.
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
