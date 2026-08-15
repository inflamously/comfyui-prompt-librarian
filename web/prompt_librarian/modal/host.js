/* ==========================================================================
   Prompt Librarian — the ComfyUI host handle
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   The host bag is shared with web/prompt_librarian/index.js (same singleton
   key), which assigns `app` in its `setup()`. Modules under this domain never
   import the entry file — that would re-run `registerExtension` under a second
   cache-busted URL — so this bag is the handoff.
   ========================================================================== */

import { singleton } from "../shared/singleton.js";

function host() {
  return singleton("host", () => ({ app: null }));
}

/** Called once from the extension entry. */
export function setHost(hostObj) {
  if (hostObj && hostObj.app) host().app = hostObj.app;
}

/** ComfyUI's `app`, or null before the entry's setup() ran. */
export function hostApp() {
  return host().app || null;
}
