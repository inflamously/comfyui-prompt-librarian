/* "This prompt changed elsewhere": shown when a save finds the record moved on
 * since it was loaded. Every choice closes the dialog first, then runs.
 */

import { Component } from "../../../shared/component.js";
import { h } from "../../../shared/dom.js";
import { fmtInt, relTime } from "../../../shared/format.js";
import { charCount, labelOf } from "../../../shared/text.js";
import { MIDDOT, quoted } from "../glyphs.js";

/**
 * deps: fresh (the server's record), mine (the buffer body), and the choices
 * onCompare(), onTheirs(), onMine(), onCancel().
 */
export class ConflictDialog extends Component {
  render() {
    const { fresh, mine, onCompare, onTheirs, onMine, onCancel } = this.deps;
    const ago = relTime(fresh.updated);
    const button = (label, onclick, kind = "") =>
      h("button", { className: "pl-btn" + kind, type: "button", onclick }, label);
    return h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Edit conflict" },
      h("div", { className: "pl-dialog-title" }, "This prompt changed elsewhere"),
      h("div", { className: "pl-dialog-body" },
        h("p", null,
          `${quoted(labelOf(fresh) || fresh.id)} changed somewhere else ${ago ? `(${ago} ago)` : ""}` +
          " while you were editing. Saving now would overwrite that change."),
        h("p", null,
          `Yours: ${fmtInt(charCount(mine))} chars ${MIDDOT} theirs: ` +
          `${fmtInt(charCount(String(fresh.body || "")))} chars.`)),
      h("div", { className: "pl-dialog-acts" },
        button("compare", onCompare),
        button("keep theirs", onTheirs),
        button("keep mine (overwrite)", onMine, " pl-btn-primary"),
        button("cancel", onCancel, " pl-btn-ghost")));
  }
}
