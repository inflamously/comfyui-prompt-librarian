/* Two texts side by side: a near duplicate, the saved text against the edit,
 * or a save conflict. Either side may be a saved prompt (an id) or bare text;
 * a side given only by id gets its text back from the diff. `U` switches
 * between split and unified; Escape is the modal's (it pops the top layer).
 */

import { ABORTED } from "../../api/request.js";
import { Component } from "../../shared/component.js";
import { clear, h } from "../../shared/dom.js";
import { onKey } from "../../shared/keys.js";
import { useStyles } from "../../shared/styles.js";
import { compareActions } from "./compare-actions.js";
import { DiffView } from "./diff-view.js";
import { reconstruct } from "./opcodes.js";
import { SWAP, errMsg, isTextEntry, str } from "./text.js";
import { btn, errorRow, skeleton } from "./ui.js";

/**
 * deps: a_id, a_text, b_id, b_text, titleA, titleB, plus the service's api,
 * lane (diff), confirm, toast, onLibraryChanged, isNarrow(), openMergeEditor(opts)
 * and close().
 */
export class CompareDialog extends Component {
  constructor(deps) {
    super(deps);
    const id = (v) => (v == null || v === "" ? null : String(v));
    this.a_id = id(deps.a_id);
    this.b_id = id(deps.b_id);
    this.titleA = str(deps.titleA) || "left";
    this.titleB = str(deps.titleB) || "right";
    this.aText = str(deps.a_text);
    this.bText = str(deps.b_text);
    this.opcodes = null;
    this.loading = true; // the first paint is a skeleton, never an error row
    this.error = "";
    this.busy = false;
    this.mode = deps.isNarrow() ? "unified" : "split";
  }

  render() {
    useStyles(new URL("./compare.css", import.meta.url));
    const { titleA, titleB } = this;
    this.matchEl = h("span", { className: "pl-row-match" }, "");
    this.summaryEl = h("span", { className: "pl-cmp-note" }, "");
    this.tabs = {
      split: h("button", { className: "pl-link", type: "button", role: "tab", title: "two columns, chunk-aligned", onclick: () => this.setMode("split") }, "split"),
      unified: h("button", { className: "pl-link", type: "button", role: "tab", title: "one column with inline changes", onclick: () => this.setMode("unified") }, "unified"),
    };
    this.labels = h("div", { className: "pl-diff" }, h("div", { className: "pl-lbl" }, titleA), h("div", { className: "pl-lbl" }, titleB));
    this.diffBox = h("div", { style: { minHeight: "0", minWidth: "0" } });
    this.acts = h("div", { className: "pl-dialog-acts" });
    const headRow = h("div", { style: { display: "flex", alignItems: "center", gap: "12px", minWidth: "0" } },
      h("div", { style: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", minWidth: "0" } },
        this.matchEl, this.summaryEl),
      h("div", { className: "pl-spacer", style: { flex: "1 1 auto" } }),
      h("div", { className: "pl-tabs", role: "tablist", "aria-label": "Diff mode", style: { padding: "0" } },
        this.tabs.split, this.tabs.unified));
    const el = h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": `compare ${titleA} with ${titleB}` },
      h("div", { className: "pl-dialog-title" }, `${titleA}  ${SWAP}  ${titleB}`),
      h("div", { className: "pl-dialog-body" }, headRow, this.labels, this.diffBox),
      this.acts);
    this.own(onKey(el, "keydown", (e) => {
      if ((e.key === "u" || e.key === "U") && !e.ctrlKey && !e.metaKey && !isTextEntry(e.target)) {
        this.setMode(this.mode === "split" ? "unified" : "split");
        e.preventDefault();
      }
    }));
    // Closing must stop a diff still loading from painting into detached DOM.
    this.own(() => {
      this.disposed = true;
      this.diff?.destroy();
      if (this.loading) this.deps.lane.cancel();
    });
    return el;
  }

  mount(parent) {
    super.mount(parent);
    this.setMode(this.mode);
    this.renderActions();
    this.reload();
    return this;
  }

  setMode(next) {
    this.mode = next === "unified" ? "unified" : "split";
    for (const [key, tab] of Object.entries(this.tabs)) tab.setAttribute("aria-selected", String(key === this.mode));
    // Inline display: the .pl-diff grid would override the browser's [hidden] rule.
    this.labels.style.display = this.mode === "unified" ? "none" : "";
    this.paintDiff();
  }

  paintDiff() {
    this.diff?.destroy();
    this.diff = null;
    clear(this.diffBox);
    if (this.loading) {
      this.diffBox.append(h("div", { className: "pl-diff" }, skeleton(3), skeleton(3)));
    } else if (!this.opcodes) {
      this.diffBox.append(errorRow(this.error || "nothing to compare", this.error ? () => this.reload() : null));
    } else {
      this.diff = new DiffView({ opcodes: this.opcodes, a: this.aText, b: this.bText, mode: this.mode }).mount(this.diffBox);
    }
  }

  /** What /compare gets: the ids, plus text for any side that has it or has no id. */
  payload() {
    const p = {};
    if (this.aText || !this.a_id) p.a_text = this.aText;
    if (this.a_id) p.a_id = this.a_id;
    if (this.bText || !this.b_id) p.b_text = this.bText;
    if (this.b_id) p.b_id = this.b_id;
    return p;
  }

  async reload() {
    if (this.disposed) return;
    this.loading = true;
    this.error = "";
    this.paintDiff();
    let res;
    try {
      res = await this.deps.lane((signal) => this.deps.api.compare(this.payload(), signal));
    } catch (err) {
      if (this.disposed) return;
      this.loading = false;
      this.error = "compare failed: " + errMsg(err);
      this.opcodes = null;
      this.paintDiff();
      this.renderActions();
      return;
    }
    if (res === ABORTED || this.disposed) return; // a newer compare is already running
    this.loading = false;
    const data = res && typeof res === "object" ? res : {};
    this.opcodes = Array.isArray(data.diff) ? data.diff : [];
    const pct = data.pct != null ? Number(data.pct) : data.score != null ? Math.round(Number(data.score) * 100) : null;
    this.matchEl.textContent = pct == null ? "" : `${pct}% match`;
    this.summaryEl.textContent = data.summary ? `differs: ${str(data.summary)}` : "";
    if (!this.aText) this.aText = reconstruct(this.opcodes, "a");
    if (!this.bText) this.bText = reconstruct(this.opcodes, "b");
    this.paintDiff();
    this.renderActions();
  }

  renderActions() {
    clear(this.acts);
    for (const s of compareActions(this)) {
      this.acts.append(btn(s.label, {
        key: s.key, kind: s.kind, title: s.title,
        disabled: s.disabled || this.busy,
        onClick: () => this.run(s.run),
      }));
    }
    this.acts.append(btn("close", { kind: "ghost", key: "close", title: "Esc", onClick: () => this.deps.close() }));
  }

  /** One action at a time; the buttons are disabled while it runs. */
  async run(action) {
    if (this.busy) return;
    this.busy = true;
    for (const b of this.acts.querySelectorAll("button")) b.disabled = true;
    try {
      await action();
    } catch (err) {
      this.deps.toast(errMsg(err), { kind: "error" });
    } finally {
      this.busy = false;
      if (!this.disposed) this.renderActions();
    }
  }
}
