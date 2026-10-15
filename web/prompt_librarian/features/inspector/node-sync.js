/* The editor's outbound half of the node binding. Edits reach the node once per
 * frame; a value that just came FROM the node is not echoed back to it.
 */

import { rafThrottle } from "../../shared/timing.js";
import { labelOf } from "../../shared/text.js";
import { quoted } from "./glyphs.js";

export class NodeSync {
  /** @param {object} pane the inspector; uses buf, disposed and deps.pushToNode/toast */
  constructor(pane) {
    this.pane = pane;
    // The inbound value, not a flag: the outbound frame runs after inbound handling ends.
    this.lastInbound = null;
    this.lastToast = null;
    this.pushBody = rafThrottle(() => {
      if (pane.disposed) return;
      if (this.lastInbound !== null && pane.buf.body === this.lastInbound) return;
      push(pane, pane.buf.body);
    });
  }

  /** Write a picked record (body and prompt_id: the link counts usage) through to the node. */
  pushRecord(rec) {
    if (!rec) return;
    this.lastInbound = null;
    this.pushBody.cancel();
    const res = push(this.pane, String(rec.body ?? ""), String(rec.id ?? ""));
    if (res && res.ok && !res.unchanged) this.loadToast(labelOf(rec) || rec.id);
  }

  /** One load notice at a time, so fast row navigation cannot stack them. */
  loadToast(label) {
    this.lastToast?.remove();
    this.lastToast = this.pane.deps.toast(`loaded ${quoted(label)} into the node`, { kind: "success", ms: 2500 });
  }

  cancel() {
    this.pushBody.cancel();
  }
}

/** The binding is a convenience: a failure there must never break an edit or a selection. */
function push(pane, ...args) {
  try {
    return pane.deps.pushToNode(...args);
  } catch (_) {
    return null;
  }
}
