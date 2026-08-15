/* ==========================================================================
   Prompt Librarian — number / date / query formatting
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Relative time in the spec's meta-line style: "just now", "5m", "3h", "2d",
 * then an absolute "Mar 4" past a week, plus the year past ~11 months.
 * Returns "" for missing/unparseable input — a meta line with a blank slot is
 * always better than "Invalid Date".
 * @param {string} iso ISO-8601 (the store writes "…Z")
 * @param {Date|number} [now]
 * @returns {string}
 */
export function relTime(iso, now) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
  const d = new Date(t);
  let secs = Math.floor((nowMs - t) / 1000);

  if (secs < 0) secs = 0; // clock skew between server and browser
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d`;

  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (secs > 330 * 86400) return `${label}, ${d.getFullYear()}`;
  return label;
}

// U+2009 THIN SPACE, spelled out because an invisible literal in source is a
// trap for the next reader (and for grep). A regular space would also let the
// number wrap across two lines mid-value; a thin space will not.
export const THIN_SPACE = String.fromCharCode(0x2009);

/**
 * Integer with thin-space grouping, as in the spec header ("1 284 prompts").
 * @param {number} n
 * @param {string} [sep=THIN_SPACE]
 * @returns {string}
 */
export function fmtInt(n, sep = THIN_SPACE) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  const neg = v < 0;
  const digits = String(Math.floor(Math.abs(v)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return neg ? "-" + out : out;
}

/**
 * Build a URLSearchParams-safe query string from a plain object.
 * Skips null/undefined/"" values, joins arrays with "," (the API's list form),
 * and renders booleans as "true"/"false". Returns "" (not "?") when empty, so
 * callers can write `path + escapeQuery(o)`.
 * @param {object} obj
 * @returns {string}
 */
export function escapeQuery(obj) {
  if (!obj) return "";
  const p = new URLSearchParams();
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      p.append(key, v.join(","));
    } else if (typeof v === "boolean") {
      p.append(key, v ? "true" : "false");
    } else {
      p.append(key, String(v));
    }
  }
  const s = p.toString();
  return s ? "?" + s : "";
}
