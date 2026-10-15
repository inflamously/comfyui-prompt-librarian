/* The storage dialog: database size, index state and reclaimable space, with
 * the migration, JSON export/import and compaction. It paints from the storage
 * slice and only calls the actions it is given; no API access of its own.
 */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";
import { useStyles } from "../../shared/styles.js";
import { bytes } from "./format.js";

/** deps: slice (storage), actions (storageActions), close(). */
export class StorageDialog extends Component {
  render() {
    useStyles(new URL("./storage.css", import.meta.url));
    const { actions, close } = this.deps;
    const button = (label, onclick, primary = false) =>
      h("button", { className: "pl-btn pl-btn-sm" + (primary ? " pl-btn-primary" : ""), type: "button", onclick }, label);
    const working = (label, work, primary = false) => {
      const btn = button(label, async () => {
        btn.textContent = "working…";
        try { await work(); } finally { btn.textContent = label; }
      }, primary);
      return btn;
    };
    const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });
    this.listen(file, "change", () => {
      const selected = file.files && file.files[0];
      file.value = "";
      if (selected) actions.importJson(selected);
    });
    this.status = h("div", { className: "pl-storage-status" });
    this.migrate = working("Import legacy data", actions.importLegacy);
    this.exportBtn = working("Export JSON", actions.exportJson);
    this.importBtn = button("Import JSON", () => file.click());
    this.optimize = working("Optimize storage", actions.optimize, true);
    this.watch(this.deps.slice, "*", () => this.paint());
    const el = h("div", { className: "pl-dialog pl-storage-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Storage" },
      h("div", { className: "pl-dialog-title" }, "Storage and backups"),
      this.status,
      h("div", { className: "pl-dialog-acts" }, this.migrate, this.exportBtn, this.importBtn, this.optimize, button("Close", () => close()), file));
    this.paint();
    return el;
  }

  paint() {
    const { storage: raw, busy } = this.deps.slice.get();
    const storage = raw || {};
    const index = storage.index || {};
    this.status.replaceChildren(
      h("div", null, `database: ${bytes(storage.database_bytes)} · ${storage.records || 0} prompts`),
      h("div", null, `search index: ${index.state || "unknown"}${index.fts5 ? " · FTS5" : ""}`),
      h("div", null, `reclaimable: ${bytes(storage.reclaimable_bytes)}`));
    this.migrate.hidden = !storage.legacy?.available;
    this.optimize.hidden = !storage.should_compact;
    for (const btn of [this.migrate, this.exportBtn, this.importBtn, this.optimize]) btn.disabled = !!busy;
  }
}
