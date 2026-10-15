/* The inspector's ways into the compare dialogs (deps.compare): diff against
 * the saved text, the version history, a near match, and a save conflict.
 */

import { labelOf } from "../../shared/text.js";
import { unwrapRecord } from "./records.js";

/** Diff the buffer against the record as saved. */
export function openDiffVsSaved(pane) {
  if (!pane.diffOk()) return;
  if (!pane.current || !pane.current.id) return pane.toast("nothing saved to diff against");
  if (!pane.isDirty()) return pane.toast("no changes");
  pane.deps.compare.compare({
    a_id: pane.current.id,
    a_text: String(pane.baseline ? pane.baseline.body || "" : ""),
    b_text: pane.buf.body,
    titleA: "saved",
    titleB: "editing",
  });
}

/** The selected record's history; a restored version is adopted and pushed. */
export function openVersions(pane) {
  if (!pane.capOk("versions")) return;
  if (!pane.current || !pane.current.id) return pane.toast("select a saved prompt first");
  pane.deps.compare.versions({
    id: pane.current.id,
    record: pane.current,
    onRestored: (rec) => { if (rec) pane.adoptRecord(unwrapRecord(rec), { push: true }); },
  });
}

/** The buffer beside a near match from the dupes panel. */
export function compareWith(pane, m) {
  pane.deps.compare.compare({
    a_id: pane.current && pane.current.id ? pane.current.id : null,
    a_text: pane.buf.body,
    b_id: m.id,
    b_text: m.body,
    titleA: labelOf(pane.buf.body) || "this",
    titleB: m.label,
  });
}

/** Mine beside theirs, from the conflict dialog. */
export function compareConflict(pane, fresh) {
  pane.deps.compare.compare({
    a_id: fresh.id,
    a_text: pane.buf.body,
    b_id: fresh.id,
    b_text: String(fresh.body || ""),
    titleA: "mine",
    titleB: "theirs",
  });
}
