const LINK_KEY = "pl:link";

/** Default to linked so the panel starts from the text the workflow will render.
 */
export function readLinkPref() {
  try {
    if (typeof localStorage === "undefined") return true;
    const raw = localStorage.getItem(LINK_KEY);
    return raw == null ? true : raw !== "0";
  } catch (_) {
    return true; // private mode / blocked storage — the default still applies
  }
}

export function writeLinkPref(on) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LINK_KEY, on ? "1" : "0");
  } catch (_) {
    /* best effort — the toggle still works for this session */
  }
}

