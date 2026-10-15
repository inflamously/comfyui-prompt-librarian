/* Stylesheets load as <link> elements, once per file. A component passes a URL
 * resolved from its own import.meta.url, which keeps ComfyUI's mount name and
 * any proxy prefix, and drops the module's cache-busting query:
 *
 *     useStyles(new URL("./rail.css", import.meta.url));
 */

import { NS } from "./ns.js";

const ATTR = "data-pl-css";

/** Add a stylesheet <link> unless that file is already linked; null without a document. */
export function useStyles(href) {
  if (typeof document === "undefined") return null;
  const url = new URL(String(href));
  const key = url.pathname;
  const existing = [...document.querySelectorAll(`link[${ATTR}]`)].find(
    (link) => link.getAttribute(ATTR) === key,
  );
  if (existing) return existing;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url.href;
  link.setAttribute(ATTR, key);
  link.addEventListener("error", () => {
    console.error(`${NS} failed to load stylesheet: ${url.href}`);
  });
  (document.head || document.documentElement).appendChild(link);
  return link;
}

/* The shared/ui sheets, linked up front in cascade order: the modal, its
 * features and the node card all build on them, and later sheets (each
 * component's own) may refine them. */
const PACK_SHEETS = [
  "./ui/tokens.css",
  "./ui/layer-stack.css",
  "./ui/popover.css",
  "./ui/dialog.css",
  "./ui/toast.css",
  "./ui/base.css",
  "./ui/link.css",
  "./ui/search.css",
  "./ui/chip.css",
  "./ui/tabs.css",
  "./ui/list.css",
  "./ui/text-area.css",
  "./ui/stars.css",
  "./ui/button.css",
];

/** Link the shared sheets; returns the last one's <link>. */
export function ensureStyles() {
  let link = null;
  for (const sheet of PACK_SHEETS) link = useStyles(new URL(sheet, import.meta.url));
  return link;
}
