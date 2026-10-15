/* The library slice: taxonomy and totals, reloads after writes, and error reporting. */

import { NS } from "../shared/ns.js";
import { ABORTED, ApiError } from "../api/request.js";
import { lanes } from "../api/lanes.js";
import { API } from "../api/routes.js";
import { inst, slice, toast } from "./instance.js";

function normaliseTags(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => {
      if (typeof t === "string") return { name: t, count: 0 };
      if (!t || typeof t !== "object") return null;
      // The store answers {tag, count}; the state shape uses {name, count}.
      return { name: String(t.name != null ? t.name : t.tag || ""), count: Number(t.count) || 0 };
    })
    .filter((t) => t && t.name);
}

export async function loadTaxonomy(isActive = () => true) {
  const res = await lanes.taxonomy((signal) => API.taxonomy(signal));
  if (!isActive() || res === ABORTED || !res) return;
  const tags = normaliseTags(res.tags);
  const library = slice("library");
  library.set({
    tags,
    tagCount: tags.length,
    total: Number(res.total) || 0,
    rev: Number(res.rev) || library.get("rev"),
  });
}

export async function refreshAll() {
  const { list } = inst().panes;
  await Promise.all([
    loadTaxonomy().catch((err) => reportError(err, "taxonomy")),
    Promise.resolve()
      .then(() => list?.refresh({ reset: true }))
      .catch((err) => reportError(err, "search")),
  ]);
}

/** Reload after a write made elsewhere; a counted use only moves counters, so the list stays put. */
export function applyRemoteChange({ op, rev } = {}) {
  const library = slice("library");
  const next = Number(rev) || 0;
  if (next && next <= library.get("rev")) return Promise.resolve();
  if (op === "usage") {
    library.set({ rev: next });
    return Promise.resolve();
  }
  return refreshAll();
}

export function reportError(err, what) {
  if (err === ABORTED) return;
  const msg =
    err instanceof ApiError
      ? err.code === "not_json"
        ? "the librarian backend is not responding (is the extension loaded?)"
        : err.message
      : (err && err.message) || String(err);
  console.error(`${NS} ${what} failed`, err);
  toast(`${what}: ${msg}`, { kind: "error", ms: 6000 });
}
