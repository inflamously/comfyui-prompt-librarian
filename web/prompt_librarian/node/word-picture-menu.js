/* Node menu items for word pictures:
 *   - "Use as picture for words…" on any node showing an image: the server
 *     shrinks that image (named as ComfyUI's /view URL names it) to a WebP and
 *     adds it to every word you enter (up to nine pictures per word);
 *   - "Generate word pictures…" on the Prompt Librarian node, which renders
 *     every non-filler vocabulary word with the open workflow (word-pictures/).
 *
 * Hooked through the long-standing `getExtraMenuOptions` prototype method;
 * index.js wraps it per node type, and a frontend without it simply never
 * shows the items.
 */

import { warnOnce } from "../shared/singleton.js";
import { ensureStyles } from "../shared/styles.js";

const LIBRARIAN = "PromptLibrarian";
/** Shown before the label; menus render `content` as text, so an emoji is the
 * one icon that works in every frontend version. */
export const PICTURE_ICON = "🖼️";
export const PICTURE_ITEM = `${PICTURE_ICON} Use as picture for words…`;

/** `{filename, subfolder, type}` for the image the node is showing, or null. */
export function shownImageRef(node) {
  const index = Number.isInteger(node?.imageIndex) ? node.imageIndex : 0;
  const fromSrc = refFromSrc(node?.imgs?.[index]?.src || node?.imgs?.[0]?.src);
  if (fromSrc) return fromSrc;
  const meta = node?.images?.[index] || node?.images?.[0];
  if (meta && typeof meta.filename === "string" && meta.filename) {
    return { filename: meta.filename, subfolder: meta.subfolder || "", type: meta.type || "output" };
  }
  return null;
}

function refFromSrc(src) {
  if (!src) return null;
  try {
    const params = new URL(src, globalThis.location?.href || "http://localhost/").searchParams;
    const filename = params.get("filename");
    if (!filename) return null;
    return { filename, subfolder: params.get("subfolder") || "", type: params.get("type") || "output" };
  } catch (_) {
    return null;
  }
}

/** Wrap a node type's context menu so image nodes offer the item. Idempotent. */
export function addWordPictureMenu(nodeType, app) {
  const proto = nodeType?.prototype;
  if (!proto || proto.__plWordPicture) return;
  proto.__plWordPicture = true;
  const original = proto.getExtraMenuOptions;
  proto.getExtraMenuOptions = function (canvas, options) {
    const result = original?.apply(this, arguments);
    if (Array.isArray(options) && shownImageRef(this)) {
      options.push({
        content: PICTURE_ITEM,
        callback: () => void attachFromNode(this, app),
      });
    }
    if (Array.isArray(options) && this.comfyClass === LIBRARIAN) {
      options.push({
        content: "Generate word pictures…",
        callback: () => void generateFromNode(this, app),
      });
    }
    return result;
  };
}

// What the autocomplete vocabulary counts as one word: letters, numbers, marks
// and underscores (so "1girl" and "red_fox" are single words, "red fox" is not).
const SINGLE_WORD = /^[\p{L}\p{N}\p{M}_]+$/u;

/** True when `text`, trimmed, is exactly one word. */
export function isSingleWord(text) {
  return SINGLE_WORD.test(String(text || "").trim());
}

async function promptOnce(app, message, defaultValue) {
  const dialog = app?.extensionManager?.dialog;
  if (typeof dialog?.prompt === "function") {
    return dialog.prompt({ title: "Picture for words", message, defaultValue });
  }
  return globalThis.prompt?.(message, defaultValue) ?? null;
}

/** The words in an answer: split on spaces and commas, repeats dropped. */
export function splitWords(text) {
  const seen = new Set();
  const out = [];
  for (const word of String(text || "").split(/[\s,]+/)) {
    const key = word.toLowerCase();
    if (word && !seen.has(key)) { seen.add(key); out.push(word); }
  }
  return out;
}

/** Ask until every entry is a single word; the words, or null when the user cancels. */
export async function askWords(app) {
  let message = "Which words does this image show? Separate several with spaces or commas.";
  let answer = "";
  for (;;) {
    const raw = await promptOnce(app, message, answer);
    if (raw == null) return null;
    answer = String(raw).trim();
    const words = splitWords(answer);
    if (!words.length) return null;
    const bad = words.filter((w) => !isSingleWord(w));
    if (!bad.length) return words;
    const list = bad.map((w) => `“${w}”`).join(", ");
    message = `${list} ${bad.length === 1 ? "is not a word" : "are not words"}. ` +
      "Use letters and numbers only, separated by spaces or commas:";
  }
}

function notify(app, severity, summary, detail) {
  const toast = app?.extensionManager?.toast;
  if (typeof toast?.add === "function") toast.add({ severity, summary, detail, life: 3000 });
}

/** What the toast says after attaching: who got the picture, who was full. */
export function attachSummary(saved) {
  const done = (saved?.words || [saved]).filter(Boolean).map((w) => `“${w.word}”`);
  const full = (saved?.skipped || []).map((w) => `“${w}”`);
  let text = `added to ${done.join(", ")}`;
  if (full.length) text += `; ${full.join(", ")} already ${full.length === 1 ? "has" : "have"} 9 pictures`;
  return text;
}

/** Ask for the words, attach the shown image to each, and refresh the preview's map. */
export async function attachFromNode(node, app) {
  const ref = shownImageRef(node);
  if (!ref) return;
  const words = await askWords(app);
  if (!words) return;
  try {
    const mod = await import("../api/index.js");
    const saved = await mod.API.attachWordImage({ words, ...ref });
    const preview = await import("../inspector/word-preview.js");
    for (const entry of saved.words || [saved]) preview.rememberPicture(entry.word, entry);
    notify(app, "success", "Picture saved", attachSummary(saved));
  } catch (err) {
    notify(app, "error", "Picture not saved", String(err?.message || err));
    warnOnce("word-picture", "could not attach the picture", err);
  }
}

async function generateFromNode(node, app) {
  ensureStyles();
  try {
    const mod = await import("../word-pictures/start.js");
    await mod.startWordPictures(node, app);
  } catch (err) {
    warnOnce("word-pictures-load", "the word-picture generator could not be loaded", err);
  }
}
