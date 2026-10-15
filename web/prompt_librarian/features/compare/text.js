/* Text helpers for the compare dialogs. Prompt and version text is always
 * rendered through textContent, never innerHTML.
 */

/* Glyphs by code point, so a wrong or absent charset cannot mangle them. */
export const ARROW = String.fromCharCode(0x2192); // →
export const MIDDOT = String.fromCharCode(0x00b7); // ·
export const SWAP = String.fromCharCode(0x2194); // ↔
const LDQUO = String.fromCharCode(0x201c);
const RDQUO = String.fromCharCode(0x201d);

/** null and undefined as "", anything else as a string. */
export function str(v) {
  return v == null ? "" : String(v);
}

/** Wrap in curly quotes. */
export function quote(s) {
  return LDQUO + str(s) + RDQUO;
}

/** Whitespace-separated words, the unit the diff works in. */
export function tokensOf(text) {
  const s = str(text).trim();
  return s ? s.split(/\s+/) : [];
}

/** A record's name for a dialog: its label, else its text, cut at a word near `n`. */
export function shortLabel(rec, n = 64) {
  if (!rec) return "";
  const given = rec.label == null ? "" : String(rec.label).trim();
  const flat = (given || str(rec.body == null ? rec.preview : rec.body)).replace(/\s+/g, " ").trim();
  if (flat.length <= n) return flat;
  let cut = flat.slice(0, n);
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor(n / 2)) cut = cut.slice(0, space);
  return cut.replace(/[ ,;:.\-]+$/, "") + String.fromCharCode(0x2026);
}

/** A readable reason for a failed request. */
export function errMsg(err) {
  if (!err) return "unknown error";
  if (err.code === "not_json") return "the librarian backend is not responding";
  return str(err.message || err) || "request failed";
}

/** The record in an API envelope, carrying the envelope's derived label onto it. */
export function unwrapRecord(res) {
  if (!res || typeof res !== "object") return null;
  let rec = null;
  if (res.prompt && typeof res.prompt === "object") rec = res.prompt;
  else if (res.record && typeof res.record === "object") rec = res.record;
  else if (res.id) return res;
  if (!rec) return null;
  if (typeof res.label === "string" && res.label) rec.label = res.label;
  return rec;
}

/** Whether keys typed at `node` belong to a text field rather than to a shortcut. */
export function isTextEntry(node) {
  const tag = String(node?.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node?.isContentEditable === true;
}
