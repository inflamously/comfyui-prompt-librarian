import { isFn } from "./common.js";

/** setRangeText does not fire input; dispatch once so dirty state and dupe checks update.
 */
export function dispatchInput(ta) {
  try {
    if (typeof Event === "function") {
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
  } catch (_) {
  }
  try {
    if (typeof document !== "undefined" && isFn(document.createEvent)) {
      const ev = document.createEvent("Event");
      ev.initEvent("input", true, false);
      ta.dispatchEvent(ev);
    }
  } catch (_) {
    /* the caller's own oninput path still runs on real typing */
  }
}

/** @param {HTMLTextAreaElement|HTMLInputElement} ta
 * @param {string} text
 * @returns {boolean} whether anything was inserted
 */
export function insertAtCaret(ta, text) {
  if (!ta) return false;
  const value = String(text == null ? "" : text);
  const len = String(ta.value == null ? "" : ta.value).length;
  const s = typeof ta.selectionStart === "number" ? ta.selectionStart : len;
  const e = typeof ta.selectionEnd === "number" ? ta.selectionEnd : s;

  if (isFn(ta.setRangeText)) {
    ta.setRangeText(value, s, e, "end");
  } else {
    const cur = String(ta.value == null ? "" : ta.value);
    ta.value = cur.slice(0, s) + value + cur.slice(e);
    ta.selectionStart = ta.selectionEnd = s + value.length;
  }
  dispatchInput(ta);
  try {
    ta.focus();
  } catch (_) {
    /* focus is a nicety */
  }
  return true;
}
