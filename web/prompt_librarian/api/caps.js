/* ==========================================================================
   Prompt Librarian — backend capability flags
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { singleton } from "../shared/singleton.js";

/**
 * Backend capability flags, filled in by `API.ping()`.
 *
 * Every known key starts `true` and is only turned off by a ping that says so.
 * Optimistic-by-default matters: if `/ping` itself fails (old backend, route
 * registration skipped) we must not disable the entire UI — the individual
 * calls will fail with an ApiError the user can actually read, which is far
 * more diagnosable than a panel full of greyed-out buttons.
 */
export const caps = singleton("caps", () => ({
  search: true,
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

/** `false` only when the backend explicitly said so. */
export function capable(name) {
  return caps[name] !== false;
}

/** Fold a `/ping` payload's capability map into `caps`. */
export function applyCaps(payload) {
  const src =
    payload && typeof payload === "object"
      ? payload.capabilities || payload.caps || null
      : null;
  if (!src || typeof src !== "object") return caps;
  for (const key of Object.keys(src)) caps[key] = !!src[key];
  return caps;
}
