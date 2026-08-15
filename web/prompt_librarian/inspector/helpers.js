/* ==========================================================================
   Prompt Librarian — the inspector's helper table
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   The pane reads its DOM/format helpers off `ctx.dom` (which modal/ctx.js
   fills from shared/) rather than importing them directly, so a partially
   loaded helper module degrades to the hand-rolled fallback instead of
   throwing at mount time.
   ========================================================================== */

import { fallbackDebounce, fallbackH, fallbackRafThrottle } from "./fallbacks.js";

/**
 * @param {object} ctx
 * @returns {object} every helper the pane uses, guaranteed callable
 */
export function resolveHelpers(ctx) {
  const D = (ctx && ctx.dom) || {};
  return {
    h: D.h || fallbackH,
    clearEl: D.clear || ((n) => { if (n) n.textContent = ""; return n; }),
    debounce: D.debounce || fallbackDebounce,
    rafThrottle: D.rafThrottle || fallbackRafThrottle,
    charCount: D.charCount || ((s) => (s == null ? 0 : Array.from(String(s)).length)),
    estimateTokens:
      D.estimateTokens ||
      ((s) => (String(s || "").trim() ? String(s).trim().split(/\s+/).length : 0)),
    starsOf: D.stars || ((r) => "*".repeat(Math.max(0, Math.min(5, Math.round(r || 0))))),
    labelOf:
      D.labelOf ||
      ((x) => {
        if (x == null) return "";
        if (typeof x === "string") return x.replace(/\s+/g, " ").trim().slice(0, 64);
        const given = x.label == null ? "" : String(x.label).trim();
        return given || String(x.body || x.preview || "").replace(/\s+/g, " ").trim().slice(0, 64);
      }),
    relTime: D.relTime || ((iso) => (iso ? String(iso).slice(0, 10) : "")),
    fmtInt: D.fmtInt || ((n) => String(Math.floor(Number(n) || 0))),
    STAR_FULL: D.STAR_FULL || String.fromCharCode(0x2605),
    STAR_EMPTY: D.STAR_EMPTY || String.fromCharCode(0x2606),
    NO_AUTOFILL: D.NO_AUTOFILL || {
      autocomplete: "off",
      "data-form-type": "other",
      "data-lpignore": "true",
      "data-1p-ignore": "",
      "data-bwignore": "true",
      "data-protonpass-ignore": "true",
    },
  };
}
