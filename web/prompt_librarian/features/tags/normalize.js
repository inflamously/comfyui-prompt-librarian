/* Tag text rules shared by the picker and its callers; pure functions. */

// Both mirror prompt_librarian/shared/records.py.
const MAX_TAG_CHARS = 40;
export const MAX_TAGS = 32;

/** Mirror the backend's whitespace and length rules. JavaScript lowercasing only
 * approximates Python's casefold; it does not cover every Unicode expansion.
 */
export function normalizeTag(tag) {
  const text = String(tag ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return text.slice(0, MAX_TAG_CHARS);
}

/** Normalize `[{name, count}]` / `["name"]` taxonomy shapes to `[{name, count}]`. */
export function taxonomyRows(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (item == null) continue;
    const name = typeof item === "object" ? String(item.name ?? "") : String(item);
    if (name) out.push({ name, count: typeof item === "object" ? Number(item.count) || 0 : 0 });
  }
  return out;
}
