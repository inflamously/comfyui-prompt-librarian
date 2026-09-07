import { singleton } from "../shared/singleton.js";
import { ABORTED, isAbort } from "./request.js";

/** A new run supersedes the previous one. Abort releases the connection;
 * the sequence guard also rejects late results from work that ignores abort.
 * Keep lanes independent so duplicate scans cannot cancel searches.
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
      }
    }
    ctrl = null;
  };
  run.busy = () => inflight > 0;
  run.laneName = String(name || "lane");
  return run;
}

/** Share lanes across cache-busted module instances so cancellation still works.
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
    }
  }
}
