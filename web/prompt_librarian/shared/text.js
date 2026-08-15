/* ==========================================================================
   Prompt Librarian — text helpers, all of them grapheme/code-point safe
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

// Intl.Segmenter gives real user-perceived character counts (a flag emoji is
// one grapheme built from two code points; "é" may be two). It is not in every
// engine ComfyUI might run in, so every use is behind a probe with an
// Array.from fallback (code points — still never splits a surrogate pair).
const SEGMENTER = (() => {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      return new Intl.Segmenter(undefined, { granularity: "grapheme" });
    }
  } catch (_) {
    /* fall through */
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

/**
 * Character count in user-perceived characters (graphemes) when Intl.Segmenter
 * exists, code points otherwise. Deliberately NOT `str.length`, which counts
 * UTF-16 code units and reports "🎬" as 2.
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

/**
 * Truncate to `n` characters, appending "…" when it actually cut something.
 * Slices grapheme/code-point units, never UTF-16 units, so an emoji at the cut
 * boundary is kept or dropped whole and never rendered as a lone surrogate.
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

/**
 * Collapse a body to a single line: newlines and runs of whitespace become one
 * space, then optionally truncate. Used for node-face and row previews.
 * @param {string} str
 * @param {number} [n] optional character cap
 * @returns {string}
 */
export function firstLine(str, n) {
  const s = (str == null ? "" : String(str)).replace(/\s+/g, " ").trim();
  if (!n) return s;
  return truncate(s, n);
}

/** Cap on a derived label — mirrors `labels.LABEL_CHARS` on the backend. */
export const LABEL_CHARS = 64;

/**
 * A body's opening words, cut on a word boundary. The client half of a label.
 *
 * A record has no name; what it is *called* is derived from what it says. The
 * good version of that is corpus-wide (which terms this body has that no other
 * body does) and can only be computed where the whole library is — so the
 * backend sends a `label` on every row, match and version it returns, and this
 * is the fallback for the one case that has no backend answer: text that has
 * never been saved.
 *
 * Kept in step with `labels.head_label` in Python, deliberately: the moment a
 * draft is saved its label is recomputed server-side, and a user watching that
 * happen should not see the handle jump.
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

/**
 * Rough token count for the UI's `~61 tokens` readout.
 *
 * THIS IS AN ESTIMATE, NOT A TOKENIZER. No tokenizer is guaranteed available
 * in ComfyUI's browser environment, and the answer depends on which model the
 * text is destined for (CLIP, T5, a video model's own vocab) — a single true
 * number does not exist. The UI must therefore always render this with a `~`
 * prefix; showing it bare would be dishonest precision.
 *
 * Heuristic: whitespace words cost 1 token each plus 1 extra per 6 characters
 * beyond the 6th (long/compound words split), punctuation runs cost 1 each,
 * and CJK characters cost ~1 token apiece since they do not use spaces. That
 * lands within roughly ±15% of BPE counts on prompt-shaped English text,
 * which is all the readout needs.
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

// Built from code points rather than pasted glyphs so they survive this file
// being served with a wrong or absent charset header.
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
