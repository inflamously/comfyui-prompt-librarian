/* ==========================================================================
   Prompt Librarian — stylesheet injection
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only — the <link> is written by
   `ensureStyles()`, which the extension entry calls from its `setup()`.
   ========================================================================== */

import { NS } from "./ns.js";

export const CSS_LINK_ID = "pl-librarian-css";

/**
 * Idempotently inject <link id="pl-librarian-css"> for librarian.css.
 *
 * The href is derived from `import.meta.url` rather than hard-coded, because
 * the absolute URL of this package's web assets is not knowable from source:
 *
 *  - ComfyUI mounts WEB_DIRECTORY at `/extensions/<sanitised-package-name>/`.
 *    The sanitisation rules (case, separators, whether the `comfyui-` prefix
 *    survives, whether the directory or the pyproject name wins) differ
 *    between frontend versions. `/extensions/comfyui-prompt-library/` is a
 *    guess; `import.meta.url` is the answer the browser already resolved.
 *  - A reverse proxy may mount ComfyUI under a path prefix (`/comfy/`), which
 *    a root-relative href would miss.
 *  - ComfyUI appends a cache-busting `?v=<hash>` query to extension module
 *    URLs. `new URL("../librarian.css", import.meta.url)` resolves against the
 *    path only and drops that query, so the CSS URL stays stable while the
 *    module URL churns — which also means the browser caches the CSS.
 *
 * The `../` is load-bearing: this module lives in `shared/`, the stylesheet
 * one level up in the domain root next to the extension entry.
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
  // Log the RESOLVED url, not the relative one — if the mount point guess is
  // wrong this message is the entire diagnosis.
  link.addEventListener("error", () => {
    console.error(`${NS} failed to load stylesheet: ${href}`);
  });
  (document.head || document.documentElement).appendChild(link);
  return link;
}
