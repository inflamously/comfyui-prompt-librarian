/* What the versions pane's buttons do: restore a snapshot, send a version to
 * the node without saving it, or copy its text.
 */

import { copyText } from "./clipboard.js";
import { errMsg, str, unwrapRecord } from "./text.js";

export const RESTORE_CONFIRM = "Restores this version as a new version. History is not erased.";

/** Restore `item`; the body it replaces becomes a version itself. */
export async function restore(dlg, item) {
  if (!item || item.isCurrent) return;
  const { api, confirm, toast, onLibraryChanged, onRestored } = dlg.deps;
  const ok = await confirm({ title: "restore this version?", message: RESTORE_CONFIRM, confirmLabel: "Restore" });
  if (!ok) return;
  try {
    const rec = unwrapRecord(await api.restoreVersion(dlg.id, item.index));
    toast("restored — the previous body is now a version", { kind: "success" });
    if (rec) {
      dlg.currentBody = str(rec.body);
      dlg.record.label = rec.label ?? dlg.record.label;
      dlg.record.updated = rec.updated ?? dlg.record.updated;
      dlg.record.body = dlg.currentBody;
    }
    onRestored?.(rec);
    onLibraryChanged();
    await dlg.reload();
  } catch (err) {
    toast("restore failed: " + errMsg(err), { kind: "error" });
  }
}

/** Send `item`'s text to the node WITHOUT saving it. */
export function loadIntoNode(dlg, item) {
  const text = dlg.bodyFor(item);
  if (!item || (!item.isCurrent && !text)) return;
  const { toast } = dlg.deps;
  const res = dlg.deps.loadIntoNode({ ...dlg.record, id: dlg.record.id || dlg.id, body: text });
  if (res && res.ok === false) {
    toast(res.reason === "stale_target" ? "that node is gone — pick another" : "could not load into the node", { kind: "error" });
  } else if (res && res.unchanged) {
    toast("the node already holds this text", { kind: "info" });
  } else {
    toast("sent to the node (not saved)", { kind: "success" });
  }
}

/** Copy `item`'s text to the clipboard. */
export async function copy(dlg, item) {
  const text = dlg.bodyFor(item);
  if (!item || (!item.isCurrent && !text)) return;
  const ok = await copyText(text);
  dlg.deps.toast(ok ? "copied" : "could not copy — select the text and copy manually", { kind: ok ? "success" : "error" });
}
