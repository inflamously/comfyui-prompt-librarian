/* The star rating. A click or key applies at once and is written in the
 * background; a failed write puts the old rating back.
 */

import { bufferFrom, errMsg, sig, unwrapRecord } from "./records.js";
import { ABORTED, ensureOk } from "../../api/request.js";

/** A click on one of the stars. */
export function onStarClick(pane, e) {
  const i = Number(e?.target?.dataset?.i);
  if (Number.isFinite(i)) rate(pane, i);
}

/** Arrows step the rating; 0–5 sets it. */
export function onStarKey(pane, e) {
  if (!pane.current || !pane.current.id) return;
  const cur = Number(pane.current.rating) || 0;
  let next = null;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(5, cur + 1);
  else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, cur - 1);
  else if (e.key >= "0" && e.key <= "5") next = Number(e.key);
  if (next === null) return;
  e.preventDefault();
  rate(pane, next);
}

/** Set the open record's rating to `value` (0–5). */
export async function rate(pane, value) {
  if (!pane.current || !pane.current.id || pane.ratingBusy) return;
  const id = pane.current.id;
  const prev = Number(pane.current.rating) || 0;
  const next = Math.max(0, Math.min(5, Math.round(value)));
  if (next === prev) return;
  pane.ratingBusy = true;
  pane.current.rating = next;
  pane.renderStars(next);
  try {
    const res = await pane.deps.api.rate(id, next);
    if (res === ABORTED) throw new Error("aborted");
    const rec = unwrapRecord(ensureOk(res));
    if (rec && rec.id && pane.current && pane.current.id === rec.id) {
      pane.current.rating = Number(rec.rating) || next;
      if (pane.baseline) pane.baseline.rating = pane.current.rating;
      // The server stamps `updated` on a rating. Adopt it only when the rest of the
      // record is what we loaded, or our own next save reads as a conflict; a body
      // changed elsewhere must keep the old stamp so that it still does.
      if (rec.updated && pane.baseline && sig(bufferFrom(rec)) === sig(bufferFrom(pane.baseline))) {
        pane.current.updated = rec.updated;
        pane.baseline.updated = rec.updated;
      }
      pane.renderStars(pane.current.rating);
    } else if (pane.baseline) {
      pane.baseline.rating = next;
    }
  } catch (err) {
    if (pane.current && pane.current.id === id) {
      pane.current.rating = prev;
      pane.renderStars(prev);
    }
    pane.toast("could not save rating: " + errMsg(err), "error");
  } finally {
    pane.ratingBusy = false;
  }
}
