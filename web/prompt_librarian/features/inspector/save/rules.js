/* The save decisions, as pure functions. See save-flow.js for how they run. */

import { fmtInt } from "../../../shared/format.js";
import { MDASH } from "../glyphs.js";
import { bufferFrom, sig } from "../records.js";

/** Normalized similarity this close to 1 is an exact copy; allows float noise. */
export const EXACT = 0.9999;

/**
 * Whether a save may start: null to go ahead, or the status to stop with.
 * Unchanged records stop before any duplicate request, so an outage cannot create a copy.
 * @param {{disposed?: boolean, saving?: boolean, dirty?: boolean, hasRecord?: boolean, body?: string}} s
 * @returns {null|{status: "busy"|"clean"|"blocked", toast?: string, tone?: string, focusBody?: boolean}}
 */
export function preflight(s) {
  if (s.disposed || s.saving) return { status: "busy" };
  if (!s.dirty && s.hasRecord) return { status: "clean", toast: "no changes" };
  if (!String(s.body || "").trim()) {
    return { status: "blocked", toast: "prompt text is empty", tone: "error", focusBody: true };
  }
  return null;
}

/** Whether this save overwrites the selected record (Update) rather than creating one. */
export function isUpdateSave(asNew, current) {
  return !asNew && !!(current && current.id);
}

/**
 * Count near matches and find an exact copy. Muted matches never count. The
 * current record is excluded only on update; when creating from an edit it is
 * still a relevant match.
 * @returns {{near: number, exact: object|null}}
 */
export function classifyMatches(matches, { threshold, isUpdate, curId }) {
  const found = (matches || []).filter((m) => !m.ignored && !(isUpdate && String(m.id) === String(curId)));
  return {
    near: found.filter((m) => m.score >= threshold).length,
    exact: found.find((m) => m.score >= EXACT) || null,
  };
}

/** Similarity scores only the body, so an exact copy of the current record must
 * update its tags rather than adopt the old ones or create an identical twin.
 * @returns {"commit"|"update-current"|"adopt"}
 */
export function exactAction({ exact, isUpdate, curId }) {
  if (!exact || isUpdate) return "commit";
  if (curId && String(exact.id) === String(curId)) return "update-current";
  return "adopt";
}

/** Adoption discards the edit buffer, so body AND tags must match (tag order aside). */
export function sameContent(rec, buf) {
  if (!rec) return false;
  if (String(rec.body || "").trim() !== String((buf && buf.body) || "").trim()) return false;
  return sig({ tags: bufferFrom(rec).tags }) === sig({ tags: (buf && buf.tags) || [] });
}

/** The `expect_updated` stamp for an update: an explicit override, or the baseline's. */
export function expectUpdatedFor(baseline, opts = {}) {
  if (opts.expectUpdated !== undefined) return opts.expectUpdated;
  return baseline ? baseline.updated : undefined;
}

/** The toast after a save that has near matches. */
export function nearMessage(near) {
  return `saved ${MDASH} ${fmtInt(near)} near match${near === 1 ? "" : "es"}, see the duplicate panel`;
}
