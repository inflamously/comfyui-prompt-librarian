/* A/B: the prompt you are writing, rendered without and with one word.
 *
 * Both renders go through the open workflow exactly like word pictures do
 * (small latent, previews only; the renderer comes from features/word-pictures
 * through the wiring), with the same seed, so the only difference between the
 * two images is the word.
 */

import { wordKey } from "../../shared/pictures.js";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tidy the separators a removal leaves behind: ", ,", leading/trailing commas. */
function tidy(text) {
  return text
    .replace(/\s*,\s*(,\s*)+/g, ", ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "");
}

/** The two texts to compare.
 *
 * When the base already has the word, A is the base without it; otherwise B is
 * the base with the word appended.
 * @returns {{a: string, b: string, had: boolean}}
 */
export function withAndWithout(base, word) {
  const text = String(base || "").trim();
  const key = wordKey(word);
  if (!key) return { a: text, b: text, had: false };
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(key).replace(/ /g, "\\s+")}(?=$|[^\\p{L}\\p{N}])`, "giu");
  if (pattern.test(text)) {
    pattern.lastIndex = 0;
    return { a: tidy(text.replace(pattern, "$1")), b: text, had: true };
  }
  const trimmed = text.replace(/[\s,]+$/, "");
  return { a: text, b: trimmed ? `${trimmed}, ${String(word).trim()}` : String(word).trim(), had: false };
}

/** Render A and B one after the other; resolves to the two image references.
 *
 * @param {{renderer: object, nodeId: any, base: string, word: string,
 *          onStep?: (which: "a"|"b") => void}} options
 * @throws {Error} with a message fit for the user when the workflow cannot render.
 */
export async function runCompare({ renderer, nodeId, base, word, onStep = () => {} }) {
  if (!renderer.available()) throw new Error("this ComfyUI cannot queue prompts from extensions");
  const template = await renderer.prepare(nodeId);
  const texts = withAndWithout(base, word);
  const out = { ...texts, imageA: null, imageB: null };
  for (const which of ["a", "b"]) {
    onStep(which);
    const image = await renderer.render(template, texts[which]);
    if (!image) throw new Error("the workflow finished without an image");
    out[which === "a" ? "imageA" : "imageB"] = image;
  }
  return out;
}
