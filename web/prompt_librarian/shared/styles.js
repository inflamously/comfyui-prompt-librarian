import { NS } from "./ns.js";

export const CSS_LINK_ID = "pl-librarian-css";

/** Resolve CSS relative to import.meta.url to preserve ComfyUI mount names and
 * proxy prefixes. URL resolution drops the module cache-busting query.
 *
 * @returns {HTMLLinkElement|null} the link element, or null with no document
 */
export function ensureStyles() {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById(CSS_LINK_ID);
  if (existing) return existing;

  let href;
  try {
    href = new URL("../librarian.css", import.meta.url).href;
  } catch (err) {
    console.error(`${NS} could not resolve librarian.css URL`, err);
    return null;
  }

  const link = document.createElement("link");
  link.id = CSS_LINK_ID;
  link.rel = "stylesheet";
  link.href = href;
  link.addEventListener("error", () => {
    console.error(`${NS} failed to load stylesheet: ${href}`);
  });
  (document.head || document.documentElement).appendChild(link);
  return link;
}
