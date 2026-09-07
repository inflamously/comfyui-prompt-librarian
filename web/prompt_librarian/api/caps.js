import { singleton } from "../shared/singleton.js";

/** Default capabilities to enabled when ping fails; individual request errors
 * are more useful than silently disabling the entire panel.
 */
export const caps = singleton("caps", () => ({
  search: true,
  autocomplete: true,
  dupes: true,
  compare: true,
  merge: true,
  versions: true,
  bulk: true,
  taxonomy: true,
  wildcards: true,
  snippets: true,
  resolve: true,
  rate: true,
  usage: true,
  import_export: true,
  storage: true,
}));

export function capable(name) {
  return caps[name] !== false;
}

export function applyCaps(payload) {
  const src =
    payload && typeof payload === "object"
      ? payload.capabilities || payload.caps || null
      : null;
  if (!src || typeof src !== "object") return caps;
  for (const key of Object.keys(src)) caps[key] = !!src[key];
  return caps;
}
