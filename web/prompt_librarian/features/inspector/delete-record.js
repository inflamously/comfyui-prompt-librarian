/* Deleting the open record. The backend has no soft delete, so the dialog
 * promises no undo.
 */

import { ensureOk } from "../../api/request.js";
import { labelOf } from "../../shared/text.js";
import { quoted } from "./glyphs.js";
import { errMsg } from "./records.js";

/** Confirm, delete, clear the editor and refresh the library. */
export async function deleteRecord(pane) {
  const rec = pane.current;
  if (!rec || !rec.id) return;
  const name = quoted(labelOf(rec) || rec.id);
  let ok = false;
  try {
    ok = await pane.deps.dialogs.confirm({
      title: "Delete prompt",
      message: `Delete ${name}? This cannot be undone.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
  } catch (_) { ok = false; }
  if (!ok || pane.disposed) return;
  try {
    ensureOk(await pane.deps.api.del(rec.id));
  } catch (err) {
    pane.toast("delete failed: " + errMsg(err), "error");
    return;
  }
  pane.clearDraft(rec.id);
  pane.adoptRecord(null);
  pane.dupes.clear();
  pane.toast(`deleted ${name}`, "success");
  pane.deps.onLibraryChanged();
}
