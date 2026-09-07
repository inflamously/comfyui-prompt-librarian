import { API } from "../../api/routes.js";
import { invalidateMeta } from "../../api/meta.js";
import { readNodeText, writeNodeText } from "../../node/bind.js";
import { hostApp } from "./host.js";
import { resolveTarget, refreshTarget } from "./nodes.js";

/** Share writeNodeText with live binding so value/callback ordering agrees.
 *
 * @param {object} record needs at least {body}; {id} enables usage tracking
 * @returns {{ok: boolean, reason?: string, unchanged?: boolean}}
 */
export function loadIntoNode(record) {
  if (!record) return { ok: false, reason: "no_record" };
  const node = resolveTarget();
  if (!node) {
    refreshTarget();
    return { ok: false, reason: "stale_target" };
  }

  const body = record.body == null ? "" : String(record.body);
  const id = record.id == null ? "" : String(record.id);

  const cur = readNodeText(node);
  if (cur && cur.body === body && String(cur.id || "") === id) {
    return { ok: true, unchanged: true };
  }

  const res = writeNodeText(node, { body, id }, { canvas: hostApp() && hostApp().canvas });
  if (!res.ok) return res;

  try {
    const canvas = hostApp() && hostApp().canvas;
    if (canvas && typeof canvas.selectNode === "function") canvas.selectNode(node, false);
  } catch (_) {
    /* purely cosmetic */
  }

  noteUsage(id, body);
  return { ok: true };
}

/** Count real record loads from either selection or explicit load, once per change.
 */
export function noteUsage(id, body) {
  const rid = id == null ? "" : String(id);
  if (!rid) return;
  // Fire and forget: a usage-tracking failure must never block the load.
  Promise.resolve()
    .then(() => API.usage(rid, { body: body == null ? "" : String(body) }))
    .catch(() => {});
  invalidateMeta([rid]);
}
