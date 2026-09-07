// Prefer graphemes; the code-point fallback still preserves surrogate pairs.
const SEGMENTER = (() => {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return new Intl.Segmenter(undefined, { granularity: "grapheme" });
    }
  } catch (_) {
  }
  return null;
})();

/**
 * Split a string into grapheme clusters when possible, code points otherwise.
 * NEVER `str.split("")` — that splits surrogate pairs and mangles emoji.
 * @param {string} str
 * @returns {string[]}
 */
export function graphemes(str) {
  const s = str == null ? "" : String(str);
  if (!s) return [];
  if (SEGMENTER) {
    const out = [];
    for (const seg of SEGMENTER.segment(s)) out.push(seg.segment);
    return out;
  }
  return Array.from(s);
}

/** Count graphemes when available, otherwise code points, not UTF-16 units.
 *
 * @param {string} str
 * @returns {number}
 */
export function charCount(str) {
  const s = str == null ? "" : String(str);
  if (!s) return 0;
  if (SEGMENTER) {
    let n = 0;
    for (const _ of SEGMENTER.segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}

/** Truncate without splitting graphemes or surrogate pairs.
 *
 * @param {string} str
 * @param {number} n
 * @param {string} [ellipsis="…"]
 * @returns {string}
 */
export function truncate(str, n, ellipsis = "…") {
  const s = str == null ? "" : String(str);
  if (!(n > 0)) return "";
  const units = graphemes(s);
  if (units.length <= n) return s;
  return units.slice(0, n).join("") + ellipsis;
}

/** @param {string} str
 * @param {number} [n] optional character cap
 * @returns {string}
 */
export function firstLine(str, n) {
  const s = (str == null ? "" : String(str)).replace(/\s+/g, " ").trim();
  if (!n) return s;
  return truncate(s, n);
}

/** Cap on a derived label — mirrors `labels.LABEL_CHARS` on the backend. */
export const LABEL_CHARS = 96;

/** Fallback for unsaved bodies; keep word-boundary behavior aligned with
 * Python labels.head_label.
 *
 * @param {string} body
 * @param {number} [n=LABEL_CHARS]
 * @returns {string} `""` for an empty body — the caller owns the placeholder
 */
export function headLabel(body, n = LABEL_CHARS) {
  const flat = (body == null ? "" : String(body)).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= n) return flat;
  let cut = flat.slice(0, n);
  const space = cut.lastIndexOf(" ");
  if (space >= Math.floor(n / 2)) cut = cut.slice(0, space);
  return cut.replace(/[ ,;:.\-]+$/, "") + "…";
}

/**
 * The handle to print for a record, hit, match or version entry.
 *
 * Prefers the backend's corpus-derived `label` and falls back to the body's
 * opening words. Accepts a plain string so a raw body can be labelled too.
 *
 * @param {object|string|null} item
 * @param {number} [n=LABEL_CHARS]
 * @returns {string} `""` when there is nothing to show
 */
export function labelOf(item, n = LABEL_CHARS) {
  if (item == null) return "";
  if (typeof item === "string") return headLabel(item, n);
  const given = item.label == null ? "" : String(item.label).trim();
  if (given) return truncate(given, n);
  return headLabel(item.body != null ? item.body : item.preview, n);
}

/** Model-dependent estimate: always display with a ~ prefix.
 * Counts words, long-word fragments, punctuation runs, and CJK characters.
 *
 * @param {string} str
 * @returns {number}
 */
export function estimateTokens(str) {
  const s = str == null ? "" : String(str);
  if (!s.trim()) return 0;

  // CJK / Hangul / Kana are counted per character. Written as \u escapes so
  // the heuristic survives being served with a wrong charset header.
  const CJK = new RegExp("[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af]", "gu");
  const cjk = (s.match(CJK) || []).length;
  const rest = s.replace(CJK, " ");

  let n = 0;
  for (const word of rest.split(/\s+/)) {
    if (!word) continue;
    const letters = word.replace(/[^\p{L}\p{N}]/gu, "");
    const punct = word.length - letters.length;
    if (letters) n += 1 + Math.floor(Math.max(0, letters.length - 6) / 6);
    n += Math.min(punct, 3); // "..." style runs collapse
  }
  return n + cjk;
}

// Use code points so glyphs survive an incorrect response charset.
export const STAR_FULL = String.fromCharCode(0x2605); // BLACK STAR
export const STAR_EMPTY = String.fromCharCode(0x2606); // WHITE STAR

/**
 * Rating → "★★★★☆" (U+2605 filled, U+2606 hollow). Text, never an icon font.
 * @param {number} rating 0..5, clamped, rounded
 * @param {number} [max=5]
 * @returns {string}
 */
export function stars(rating, max = 5) {
  const r = Math.max(0, Math.min(max, Math.round(Number(rating) || 0)));
  return STAR_FULL.repeat(r) + STAR_EMPTY.repeat(max - r);
}
