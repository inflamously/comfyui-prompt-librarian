/* Changing which prompt the editor holds. Unsaved edits are never dropped on
 * the way: the gate asks to save, discard, or keep editing, and "keep editing"
 * puts the sidebar highlight back on the record still in the editor.
 */

import { ABORTED, ensureOk } from "../../api/request.js";
import { labelOf } from "../../shared/text.js";
import { quoted } from "./glyphs.js";
import { errMsg, unwrapRecord } from "./records.js";

/** Load record `id` (or clear the editor for null/""), through the unsaved-changes gate. */
export async function selectPrompt(pane, id) {
  if (pane.disposed) return;
  if (id == null || id === "") {
    pane.autocomplete.dismiss();
    pane.pendingId = null;
    pane.adoptRecord(null);
    pane.dupes.clear();
    return;
  }
  // A row click both sets `currentId` (which the pane watches) and calls select; fetch once.
  if (pane.pendingId != null && pane.pendingId === String(id)) return;
  // Re-picking the record being edited must not reload over its buffer.
  if (pane.renderedId && pane.renderedId === String(id) && pane.isDirty()) return;
  if (!(await gate(pane, id)) || pane.disposed) return;
  pane.autocomplete.dismiss();
  pane.pendingId = String(id);
  let res;
  try {
    res = await pane.deps.lane((signal) => pane.deps.api.get(String(id), signal));
  } catch (err) {
    pane.pendingId = null;
    if (!pane.disposed) pane.toast("could not load prompt: " + errMsg(err), "error");
    return;
  }
  pane.autocomplete.dismiss();
  pane.pendingId = null;
  if (res === ABORTED || pane.disposed) return;
  let rec;
  try {
    rec = unwrapRecord(ensureOk(res));
  } catch (err) {
    pane.toast("could not load prompt: " + errMsg(err), "error");
    return;
  }
  if (!rec || !rec.id) return pane.toast("prompt not found", "error");
  pane.adoptRecord(rec, { push: true });
  pane.maybeOfferDraft(rec);
  pane.dupes.check();
}

/** Run the gate once at a time: a second click cannot redirect the first answer. */
export async function gate(pane, nextId) {
  if (pane.leaving) return false;
  pane.leaving = true;
  try {
    return await confirmLeave(pane, nextId);
  } finally {
    pane.leaving = false;
  }
}

/** Whether the editor may move on to `nextId`, asking first when there is an unsaved edit. */
async function confirmLeave(pane, nextId) {
  const rec = pane.current;
  const curId = rec && rec.id ? String(rec.id) : "";
  if (curId && curId === String(nextId)) return true;
  if (!pane.isDirty()) return true;
  if (!pane.buf.body.trim() && !curId) return true;

  let answer = "cancel";
  try {
    answer = await pane.deps.dialogs.choose({
      title: "Unsaved changes",
      message: rec
        ? `You edited ${quoted(labelOf(rec) || rec.id)} without saving.\nWhat should happen to those changes?`
        : "You have an unsaved prompt in the editor.\nWhat should happen to it?",
      cancelLabel: "Keep editing",
      cancelValue: "cancel",
      choices: [
        { value: "save", label: "Save as new", primary: true },
        { value: "discard", label: "Discard", danger: true },
      ],
    });
  } catch (_) { answer = "cancel"; }
  if (pane.disposed) return false;

  if (answer === "save") {
    // Leaving creates a record; overwriting the one left behind takes an explicit Update.
    const status = await pane.requestSave(true);
    if (pane.disposed) return false;
    if (status === "saved" || status === "clean") return true;
  } else if (answer === "discard") {
    pane.discardDraft();
    if (curId) {
      pane.clearDraft(curId);
      // Clean the buffer first, or parking the draft would bring the edit back.
      pane.adoptRecord(pane.current);
    }
    return true;
  }
  restoreSelection(pane);
  return false;
}

/** Point the sidebar highlight back at the record in the editor. */
export function restoreSelection(pane) {
  pane.deps.slice.set({ currentId: pane.renderedId == null ? null : String(pane.renderedId) });
}

/** Deselect and clear, through the gate, so the next save creates a record. */
export async function newPrompt(pane) {
  if (pane.disposed || !(await gate(pane, "")) || pane.disposed) return;
  pane.autocomplete.dismiss();
  pane.pendingId = null;
  pane.adoptRecord(null);
  pane.deps.slice.set({ currentId: null }); // the sidebar highlight lets go
  pane.dupes.clear(); // any answer still in flight is about the old body
  pane.setBody(""); // and the node is cleared too
  pane.focusBody();
}
