/* Turn the open workflow into a small per-word render.
 *
 * The template is the API-format prompt from `app.graphToPrompt()`. For each
 * word, the Librarian node's text becomes the word, every Empty*Latent* node is
 * shrunk so its longest side is at most MAX_SIDE (aspect kept, batch of one),
 * and SaveImage nodes become PreviewImage, so nothing lands in your output
 * folder: previews go to ComfyUI's temp directory and are discarded later.
 */

export const MAX_SIDE = 512;
const STEP = 64;
const LIBRARIAN = "PromptLibrarian";
const LATENT = /^Empty\w*Latent/;
const IMAGE_OUTPUTS = new Set(["SaveImage", "PreviewImage"]);

/** Width and height scaled down to `maxSide`, snapped to multiples of 64. */
export function fitSize(width, height, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1));
  const snap = (value) => Math.max(STEP, Math.floor((value * scale) / STEP) * STEP);
  return [snap(width), snap(height)];
}

/** The id of the Librarian node to write words into, or null when ambiguous. */
export function librarianNodeId(output, preferredId) {
  if (output?.[String(preferredId)]?.class_type === LIBRARIAN) return String(preferredId);
  const ids = Object.keys(output || {}).filter((id) => output[id]?.class_type === LIBRARIAN);
  return ids.length === 1 ? ids[0] : null;
}

/** Check the workflow once and return what `wordPrompt` needs.
 * @throws {Error} with a message fit for the user when the workflow cannot work.
 */
export function prepareTemplate(output, preferredId, maxSide = MAX_SIDE) {
  const textId = librarianNodeId(output, preferredId);
  if (!textId) throw new Error("this workflow needs exactly one active Prompt Librarian node");
  if (typeof output[textId].inputs?.text !== "string") {
    throw new Error("the Librarian node's text is wired from another node; it needs its own text");
  }
  const nodes = Object.values(output);
  if (!nodes.some((node) => IMAGE_OUTPUTS.has(node?.class_type))) {
    throw new Error("this workflow has no Save Image or Preview Image node");
  }
  return { output, textId, maxSide };
}

/** A fresh API-format prompt that renders `word` small. */
export function wordPrompt({ output, textId, maxSide }, word) {
  const prompt = JSON.parse(JSON.stringify(output));
  prompt[textId].inputs.text = word;
  for (const node of Object.values(prompt)) {
    if (LATENT.test(node?.class_type || "")) shrinkLatent(node.inputs || {}, maxSide);
    if (node?.class_type === "SaveImage") {
      node.class_type = "PreviewImage";
      node.inputs = { images: node.inputs?.images };
    }
  }
  return prompt;
}

function shrinkLatent(inputs, maxSide) {
  if (typeof inputs.width === "number" && typeof inputs.height === "number") {
    [inputs.width, inputs.height] = fitSize(inputs.width, inputs.height, maxSide);
  }
  if (typeof inputs.batch_size === "number") inputs.batch_size = 1;
}
