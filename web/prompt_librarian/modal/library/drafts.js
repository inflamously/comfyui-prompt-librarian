/* Store the whole edit buffer as JSON at pl:draft:<id>.
 * inspector/drafts.js shares this format.
 */

const DRAFT_PREFIX = "pl:draft:";

function draftKey(id) {
  return DRAFT_PREFIX + (id || "new");
}

export function saveDraft(id, buffer) {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(draftKey(id), JSON.stringify(buffer));
  } catch (_) {
    /* quota or privacy mode — drafts are a convenience, never a requirement */
  }
}

export function loadDraft(id) {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(draftKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function clearDraft(id) {
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(draftKey(id));
  } catch (_) {
  }
}
