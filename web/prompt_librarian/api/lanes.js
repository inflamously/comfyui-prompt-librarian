/* ==========================================================================
   Prompt Librarian — request lanes
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { singleton } from "../shared/singleton.js";
import { ABORTED, isAbort } from "./request.js";

/**
 * Create an independent request lane.
 *
 *   const res = await lanes.search((signal) => API.search(params, signal));
 *   if (res === ABORTED) return;
 *
 * A lane serialises one *logical* stream of work: starting a new run
 * supersedes the previous one. It uses BOTH mechanisms, deliberately:
 *
 *  - an `AbortController`, so the superseded request stops occupying a
 *    connection and the backend can stop caring about it; and
 *  - a monotonic sequence number, because abort is not synchronous with
 *    resolution. A response that already resolved (or a promise that never
 *    honoured the signal at all — `API.meta` batching, a cached value, a
 *    non-fetch promise) would otherwise land *after* the newer one and
 *    overwrite fresh state with stale data. That race is the classic
 *    "type fast, get the results for the previous keystroke" bug, and abort
 *    alone does not close it.
 *
 * Lanes are independent so a 900 ms all-pairs dupe scan never cancels the
 * search the user is typing.
 *
 * @param {string} name for diagnostics
 * @returns {((fn: (signal: AbortSignal|undefined) => any) => Promise<any>) & {cancel: () => void, busy: () => boolean, laneName: string}}
 */
export function createLane(name) {
  let seq = 0;
  let ctrl = null;
  let inflight = 0;

  async function run(fn) {
    const mine = ++seq;
    if (ctrl) {
      try {
        ctrl.abort();
      } catch (_) {
        /* an already-aborted controller throws in some engines */
      }
    }
    ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const mineCtrl = ctrl;
    inflight++;
    try {
      const out = await fn(mineCtrl ? mineCtrl.signal : undefined);
      // Sequence guard: a newer run started while we were awaiting. Its result
      // is the truth; ours must not reach the caller.
      if (mine !== seq) return ABORTED;
      return out;
    } catch (err) {
      if (mine !== seq || isAbort(err)) return ABORTED;
      throw err;
    } finally {
      inflight--;
      if (mine === seq && ctrl === mineCtrl) ctrl = null;
    }
  }

  /** Abort the in-flight run and make its result unusable. */
  run.cancel = () => {
    seq++;
    if (ctrl) {
      try {
        ctrl.abort();
      } catch (_) {
        /* ignore */
      }
    }
    ctrl = null;
  };
  run.busy = () => inflight > 0;
  run.laneName = String(name || "lane");
  return run;
}

/**
 * The lanes the panel uses. Stored on the shared singleton bag: ComfyUI
 * cache-busts extension module URLs, so two copies of this module can exist
 * on one page, and two sets of lanes would not cancel each other.
 */
export const lanes = singleton("lanes", () => ({
  search: createLane("search"),
  dupe: createLane("dupe"),
  record: createLane("record"),
  preview: createLane("preview"),
  versions: createLane("versions"),
  diff: createLane("diff"),
  taxonomy: createLane("taxonomy"),
}));

/** Abort every lane. Called from the modal's teardown list. */
export function cancelAllLanes() {
  for (const key of Object.keys(lanes)) {
    try {
      lanes[key].cancel();
    } catch (_) {
      /* ignore */
    }
  }
}
