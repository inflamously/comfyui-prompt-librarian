import { NS } from "../../shared/ns.js";
import { ABORTED, ApiError } from "../../api/request.js";
import { lanes } from "../../api/lanes.js";
import { API } from "../../api/routes.js";
import { toast } from "../overlays/toasts.js";
import { inst, setState } from "../state.js";

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
  setState({
    tags,
    tagCount: tags.length,
    total: Number(res.total) || 0,
    rev: Number(res.rev) || inst().state.rev,
  });
}

export async function refreshAll() {
  const it = inst();
  await Promise.all([
    loadTaxonomy().catch((err) => reportError(err, "taxonomy")),
    Promise.resolve()
      .then(() => it.ctx && it.ctx.list && it.ctx.list.refresh && it.ctx.list.refresh({ reset: true }))
      .catch((err) => reportError(err, "search")),
  ]);
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
