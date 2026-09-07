/* Keep routes compatible with ComfyUI URL-prefix rewriting.
 * Bulk selection is {ids: [...]} or {query: {...}}; forward the query intact
 * so the backend can select records beyond the loaded pages.
 */

import { applyCaps } from "./caps.js";
import { download, req, upload } from "./request.js";

export const API = {

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

  exportFile() {
    return download("export/file");
  },

  storage() {
    return req("storage");
  },


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
      // Send both backend text and contract body keys for compatibility.
      body: { text: probe, body: probe, id, exclude_id, threshold, limit, summaries },
      signal,
    });
  },

  /** Keep-both annotates this pair as muted without changing duplicate counts.
   * Pass unignore to reverse the decision.
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

  settings(patch) {
    return req("settings", { method: "POST", body: { ...(patch || {}) } });
  },

  migrateLegacy() {
    return req("storage/migrate", { method: "POST", body: { source: "legacy" } });
  },

  compactStorage() {
    return req("storage/compact", { method: "POST", body: { op: "compact" } });
  },

  /**
   * @param {any} data the exported library object
   * @param {"replace"|"merge"} [mode] default "replace"
   */
  importRaw(data, mode) {
    const replace = mode !== "merge";
    return req("import", { method: "POST", body: { library: data, data, mode, replace } });
  },

  importFile(file, mode) {
    return upload("import/file", file, { query: { mode: mode || "merge" } });
  },
};
