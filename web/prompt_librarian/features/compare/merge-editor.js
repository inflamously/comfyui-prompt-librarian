/* Merge → new prompt: an editable union of both sides, saved as a NEW record so
 * neither input is touched until the save. When both sides are saved prompts,
 * the save absorbs them (both are deleted, their bodies kept as versions).
 * Ctrl/Cmd+Enter or Ctrl/Cmd+S saves.
 */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";
import { onKey } from "../../shared/keys.js";
import { useStyles } from "../../shared/styles.js";
import { mergeSeed } from "./opcodes.js";
import { ARROW, MIDDOT, errMsg, quote, shortLabel, str, unwrapRecord } from "./text.js";
import { btn } from "./ui.js";

/**
 * deps: left and right ({id, label, body, tags?}), opcodes, onSaved(rec), plus
 * the service's api, confirm, toast, onLibraryChanged and close().
 */
export class MergeEditor extends Component {
  render() {
    useStyles(new URL("./compare.css", import.meta.url));
    const { left = {}, right = {}, opcodes } = this.deps;
    const id = (v) => (v == null || v === "" ? null : String(v));
    this.a_id = id(left.id);
    this.b_id = id(right.id);
    this.busy = false;
    this.ta = h("textarea", {
      className: "pl-ta",
      value: mergeSeed(opcodes, str(left.body), str(right.body)),
      spellcheck: "false",
      "aria-label": "merged body",
    });
    this.saveBtn = btn("save as new", {
      kind: "accent",
      key: "save",
      title: this.a_id && this.b_id
        ? "creates a third prompt that absorbs both, then deletes them"
        : "creates a new prompt; nothing existing is touched",
      onClick: () => this.save(),
    });
    const el = h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "merge into a new prompt" },
      h("div", { className: "pl-dialog-title" }, `merge ${ARROW} new prompt`),
      h("div", { className: "pl-dialog-body", style: { display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { className: "pl-cmp-note", style: { margin: "2px 0 6px" } },
          `seeded with a naive union of both sides ${MIDDOT} everything from both bodies is here, in order. ` +
          "Edit it before saving."),
        h("div", { className: "pl-ta-wrap", style: { minHeight: "220px" } }, this.ta)),
      h("div", { className: "pl-dialog-acts" },
        btn("cancel", { kind: "ghost", onClick: () => this.deps.close() }),
        this.saveBtn));
    this.own(onKey(el, "keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "s" || e.key === "S")) {
        e.preventDefault();
        this.save();
      }
    }));
    this.own(() => { this.disposed = true; });
    return el;
  }

  /** Start in the text, not on the first button. */
  mount(parent) {
    super.mount(parent);
    this.ta.focus();
    return this;
  }

  async save() {
    if (this.busy || this.disposed) return;
    const { left = {}, right = {}, api, confirm, toast, onLibraryChanged, onSaved, close } = this.deps;
    const text = str(this.ta.value);
    if (!text.trim()) return toast("the merged body is empty", { kind: "error" });
    const absorbs = !!(this.a_id && this.b_id);
    if (absorbs) {
      const ok = await confirm({
        title: "save the merge?",
        message: `${quote(shortLabel(left))} and ${quote(shortLabel(right))} are absorbed into one new prompt.\n` +
          "Both originals are deleted and their bodies are kept as versions of the new prompt.",
        confirmLabel: "save as new",
        danger: true,
      });
      if (!ok) return;
    }
    this.busy = true;
    this.saveBtn.disabled = true;
    try {
      const res = absorbs
        ? await api.mergeNew({ a_id: this.a_id, b_id: this.b_id, body: text })
        : await api.create({ body: text, tags: Array.isArray(left.tags) ? left.tags.slice() : [] });
      const rec = unwrapRecord(res);
      toast(`created ${quote(shortLabel(rec) || "the merged prompt")}`, { kind: "success" });
      onLibraryChanged();
      onSaved?.(rec);
      close();
    } catch (err) {
      toast("merge failed: " + errMsg(err), { kind: "error" });
    } finally {
      this.busy = false;
      if (!this.disposed) this.saveBtn.disabled = false;
    }
  }
}
