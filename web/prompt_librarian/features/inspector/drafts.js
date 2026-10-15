/* Session drafts: an unsaved edit of a record is parked under its id, and
 * offered back (restore or discard) when that record is opened again. The
 * storage is the modal's drafts service, shared so both sides agree on the format.
 */

import { fmtInt } from "../../shared/format.js";
import { charCount } from "../../shared/text.js";
import { draftBody } from "./records.js";

/** Park the buffer under the open record, or drop the draft when it matches the record. */
export function saveDraft(pane) {
  if (!pane.current || !pane.current.id) return;
  const { drafts } = pane.deps;
  if (pane.buf.body === String(pane.current.body || "")) drafts.clear(pane.current.id);
  else drafts.save(pane.current.id, pane.getBuffer());
}

/** Show the draft bar when `rec` has a parked draft that differs from it. */
export function offerDraft(pane, rec) {
  hideDraft(pane);
  if (!rec || !rec.id) return;
  const body = draftBody(pane.deps.drafts.load(rec.id));
  if (body == null || body === String(rec.body || "")) return;
  pane.pendingDraft = body;
  pane.els.draftText.textContent = `unsaved draft found (${fmtInt(charCount(body))} chars)`;
  pane.els.draftBar.hidden = false;
}

/** Put the offered draft into the editor. */
export function restoreDraft(pane) {
  if (pane.pendingDraft == null) return;
  pane.setBody(pane.pendingDraft);
  hideDraft(pane);
  pane.toast("draft restored");
}

/** Drop the offered draft and its stored copy. */
export function discardDraft(pane) {
  hideDraft(pane);
  if (pane.current && pane.current.id) pane.deps.drafts.clear(pane.current.id);
}

export function hideDraft(pane) {
  pane.pendingDraft = null;
  pane.els.draftBar.hidden = true;
}
