/* ==========================================================================
   Prompt Librarian — the API surface, one method per route
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   Every read is GET, every write is POST — no PATCH/DELETE verbs and no path
   parameters, matching prompt_librarian/api/routes/ and staying compatible
   with ComfyUI's /api prefix rewriting.

   `sel` for the bulk operations is `{ids: [...]}` OR `{query: {...}}` and is
   spread through VERBATIM. The backend accepts both, and `{query}` is the only
   shape that scales to "select all 1 284 filtered".
   ========================================================================== */

import { applyCaps } from "./caps.js";
import { req } from "./request.js";

export const API = {
  /* -- reads -------------------------------------------------------------- */

  /** Liveness + capability probe. Also the cheapest "is the backend there?". */
  async ping(signal) {
    const data = await req("ping", { signal });
    applyCaps(data);
    return data;
  },

  /**
   * @param {object} params {q, tags[], dupes_only, group, sort, offset,
   *                         limit, threshold, match_id}
   *
   * With `group`, a row is a near-duplicate CLUSTER: `total` counts rows,
   * `record_total` counts the records behind them, and `groups[repId]` holds
   * the members the representative stands for.
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
      // `text` is what prompt_librarian/api/routes/dupes.py reads; `body` is
      // the name in the frozen frontend contract. Both are sent — an unknown
      // key is ignored by the handler, and a rename on either side cannot
      // break the hot path.
      body: { text: probe, body: probe, id, exclude_id, threshold, limit, summaries },
      signal,
    });
  },

  /**
   * "Keep both" — mute this pair in the SAVE GATE. It does not change any
   * count: the pair still shows up in the list, the badge and the duplicate
   * panel, marked as muted. Pass `unignore` to take the decision back.
   */
  ignorePair(a, b, unignore) {
    return req("dupes/ignore", {
      method: "POST",
      body: unignore ? { a, b, unignore: true } : { a, b },
    });
  },

  compare({ a_id, a_text, b_id, b_text } = {}, signal) {
    return req("compare", { method: "POST", body: { a_id, a_text, b_id, b_text }, signal });
  },

  merge({ winner_id, loser_id, body } = {}) {
    return req("merge", {
      method: "POST",
      body: { winner: winner_id, loser: loser_id, winner_id, loser_id, body },
    });
  },

  mergeNew({ a_id, b_id, body, tags } = {}) {
    return req("merge_new", {
      method: "POST",
      body: { a: a_id, b: b_id, a_id, b_id, body, tags },
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
