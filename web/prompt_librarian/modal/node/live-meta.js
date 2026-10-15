/* Keeps node faces current when the library changes elsewhere: another tab,
 * the panel, or a workflow run counting a use. Installed once from index.js.
 */

import { singleton } from "../../shared/singleton.js";
import { onLibraryChanged } from "../../api/request.js";
import { fetchMeta, invalidateMeta } from "../../api/meta.js";
import { paintFace } from "./face.js";
import { findWidget } from "./widgets.js";

const NODE_CLASS = "PromptLibrarian";

/** Subscribe once per page; later calls return the same unsubscribe. */
export function followLibrary(app) {
  return singleton("followLibrary", () => onLibraryChanged((detail) => repaintChanged(app, detail)));
}

/** Drop the cached metadata of the changed ids and repaint the nodes linked to them. */
export function repaintChanged(app, { ids } = {}) {
  const changed = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!changed.size) return Promise.resolve();
  invalidateMeta(changed);
  const repaints = linkedNodes(app)
    .filter(({ id }) => changed.has(id))
    .map(async ({ node, id }) => {
      const meta = await fetchMeta(id);
      node.__plMeta = meta || undefined;
      paintFace(node, node.__plMeta);
    });
  return Promise.all(repaints);
}

function linkedNodes(app) {
  const nodes = app?.graph?._nodes || app?.graph?.nodes || [];
  const out = [];
  for (const node of nodes) {
    if (!node || (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS)) continue;
    const id = String(findWidget(node, "prompt_id")?.value || "").trim();
    if (id) out.push({ node, id });
  }
  return out;
}
