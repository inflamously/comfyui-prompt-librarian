/* Painting the editor from the pane's state. Each function reads the pane and
 * writes its own part of the DOM; none of them changes state.
 */

import { clear, h } from "../../shared/dom.js";
import { fmtInt, relTime } from "../../shared/format.js";
import { STAR_EMPTY, STAR_FULL, charCount, estimateTokens, labelOf, stars } from "../../shared/text.js";
import { MUL } from "./glyphs.js";

/** Everything at once, e.g. after adopting a record. */
export function paintFields(pane) {
  if (pane.els.ta.value !== pane.buf.body) pane.els.ta.value = pane.buf.body;
  paintTags(pane);
  paintCounts(pane);
  paintStats(pane);
  paintActions(pane);
}

/** Characters, estimated tokens (hence "~"), the "edited" mark and the label. */
export function paintCounts(pane) {
  const { els, buf } = pane;
  els.charsEl.textContent = fmtInt(charCount(buf.body));
  els.tokensEl.textContent = "~" + fmtInt(estimateTokens(buf.body));
  els.editedEl.hidden = !pane.isDirty();
  paintLabel(pane);
}

/** The server's label while the body is unchanged; edited or unsaved text gets a
 * local one, since its corpus label no longer applies. */
export function paintLabel(pane) {
  const rec = pane.current || {};
  const label = pane.isDirty() || !rec.id
    ? labelOf(pane.buf.body)
    : labelOf({ label: rec.label, body: pane.buf.body });
  pane.els.labelEl.textContent = label || "(empty prompt)";
  pane.els.labelEl.classList.toggle("is-empty", !label);
}

/** One chip per tag (× removes it) and "+ tag". */
export function paintTags(pane) {
  const row = pane.els.tagsRow;
  clear(row);
  for (const tag of pane.buf.tags) {
    row.append(h("span", { className: "pl-chip" },
      h("span", null, tag),
      h("button", {
        className: "pl-chip-x", type: "button",
        "aria-label": "Remove tag " + tag, title: "Remove tag",
        onclick: () => pane.removeTag(tag),
      }, MUL)));
  }
  row.append(h("button", { className: "pl-chip pl-chip-add", type: "button", onclick: () => pane.openTagPicker() }, "+ tag"));
}

/** Usage, last run, version count and the rating. */
export function paintStats(pane) {
  const rec = pane.current || {};
  pane.els.usedV.textContent = fmtInt(rec.used || 0) + MUL;
  pane.els.lastV.textContent = rec.last_run ? relTime(rec.last_run) || "—" : "—";
  const versions = Array.isArray(rec.versions) ? rec.versions.length : Number(rec.version_count || 0);
  pane.els.versV.textContent = fmtInt(versions);
  paintStars(pane, Number(rec.rating) || 0);
}

/** Five stars; they only respond when a saved record is open. */
export function paintStars(pane, rating) {
  const el = pane.els.starsEl;
  const enabled = !!(pane.current && pane.current.id);
  clear(el);
  el.setAttribute("aria-disabled", enabled ? "false" : "true");
  el.setAttribute("aria-label", `Rating ${Math.round(rating)} of 5`);
  const glyphs = stars(rating);
  for (let i = 1; i <= 5; i++) {
    el.append(h("span", {
      dataset: { i: String(i) },
      role: "button",
      "aria-label": `${i} star${i === 1 ? "" : "s"}`,
      title: enabled ? `Rate ${i}/5` : "",
    }, glyphs[i - 1] || (i <= rating ? STAR_FULL : STAR_EMPTY)));
  }
}

/** Which buttons work right now: no record, a save in flight, or a missing capability disable them. */
export function paintActions(pane) {
  const { els } = pane;
  const hasRec = !!(pane.current && pane.current.id);
  els.delBtn.disabled = !hasRec || pane.saving;
  els.saveBtn.disabled = !hasRec || pane.saving;
  els.saveNewBtn.disabled = pane.saving;
  els.newBtn.disabled = pane.saving;
  els.diffLink.disabled = !pane.diffOk() || !hasRec;
  els.versLink.disabled = !pane.capOk("versions") || !hasRec;
  els.versV.disabled = !pane.capOk("versions") || !hasRec;
}
