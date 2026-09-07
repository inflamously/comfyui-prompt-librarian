/* Share the entry's host singleton instead of importing the entry, which
 * could register the extension again under a cache-busted URL.
 */

import { singleton } from "../shared/singleton.js";

function host() {
  return singleton("host", () => ({ app: null }));
}

export function setHost(hostObj) {
  if (hostObj && hostObj.app) host().app = hostObj.app;
}

/** ComfyUI's `app`, or null before the entry's setup() ran. */
export function hostApp() {
  return host().app || null;
}
