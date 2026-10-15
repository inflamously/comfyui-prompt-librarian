/* A prompt's version history: the list on the left (current body first, then
 * snapshots, newest first), and the selected snapshot diffed against the
 * current body on the right. The list holds previews only; a snapshot's full
 * body is fetched when it is selected. Arrow keys move the highlight at once and
 * load the body when navigation pauses.
 */

import { ABORTED } from "../../api/request.js";
import { Component } from "../../shared/component.js";
import { clear, cls, h } from "../../shared/dom.js";
import { onKey } from "../../shared/keys.js";
import { useStyles } from "../../shared/styles.js";
import { labelOf } from "../../shared/text.js";
import { debounce } from "../../shared/timing.js";
import { VirtualList } from "../../shared/ui/virtual-list.js";
import { DiffView } from "./diff-view.js";
import { MIDDOT, errMsg, isTextEntry, str, unwrapRecord } from "./text.js";
import { btn, errorRow, skeleton } from "./ui.js";
import { copy, loadIntoNode, restore } from "./version-actions.js";
import { buildRows, createVersionRow, paintVersionRow } from "./version-rows.js";

const VIRTUALISE_AT = 60;
const SELECT_DEBOUNCE_MS = 110;

/**
 * deps: id, record, onRestored(rec), plus the service's api, lane (versions),
 * confirm, toast, loadIntoNode, onLibraryChanged, isNarrow() and close().
 */
export class VersionsDialog extends Component {
  constructor(deps) {
    super(deps);
    this.id = str(deps.id || deps.record?.id);
    // A copy: a restore updates this view of the record, and changing the
    // inspector's own object behind its back would break its dirty check.
    this.record = { id: this.id, ...(deps.record || {}) };
    this.currentBody = str(this.record.body);
    this.rows = [];
    this.selected = 0;
    this.list = { loading: true, error: "" };
    this.pane = { state: "idle", error: "", opcodes: null, version: null }; // state: idle | loading | ready | error
    this.seq = 0; // a stale selection's response is dropped even if the lane lets it through
  }

  render() {
    useStyles(new URL("./compare.css", import.meta.url));
    this.listBox = h("div", {
      className: "pl-list", role: "listbox", tabIndex: 0, "aria-label": "versions",
      style: { border: "1px solid var(--pl-border-soft)", borderRadius: "6px", maxHeight: "100%" },
    });
    this.paneTitle = h("div", { className: "pl-lbl" }, "");
    this.paneMeta = h("span", { className: "pl-row-meta" }, "");
    this.paneActs = h("div", { className: "pl-dupe-acts", style: { marginLeft: "auto", display: "flex", gap: "8px" } });
    this.paneBody = h("div", { style: { minHeight: "0", minWidth: "0" } });
    const el = h("div", { className: "pl-dialog", role: "dialog", "aria-modal": "true", "aria-label": "version history" },
      h("div", { className: "pl-dialog-title" }, `versions ${MIDDOT} ${labelOf(this.record) || this.id}`),
      h("div", { className: "pl-dialog-body", style: { display: "grid", gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)", gap: "12px", minHeight: "0" } },
        this.listBox,
        h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: "0", minHeight: "0" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minWidth: "0" } },
            this.paneTitle, this.paneMeta, this.paneActs),
          this.paneBody)),
      h("div", { className: "pl-dialog-acts" }, btn("close", { kind: "ghost", title: "Esc", onClick: () => this.deps.close() })));
    this.scheduleSelect = debounce((i) => this.select(i), SELECT_DEBOUNCE_MS);
    // One listener for every row, so recycled rows need no rebinding.
    this.listen(this.listBox, "click", (e) => {
      const i = Number(e.target.closest?.("[data-idx]")?.dataset.idx);
      if (Number.isFinite(i)) this.select(i);
    });
    this.own(onKey(el, "keydown", (e) => this.onKey(e)));
    this.own(() => {
      this.disposed = true;
      this.seq++; // any response still in flight is now superseded
      this.scheduleSelect.cancel();
      this.diff?.destroy();
      this.vlist?.destroy();
      this.deps.lane.cancel();
    });
    return el;
  }

  mount(parent) {
    super.mount(parent);
    this.paintPane();
    this.reload();
    return this;
  }

  /** Load (or reload, after a restore) the current body and the version list. */
  async reload() {
    if (this.disposed) return;
    this.list = { loading: true, error: "" };
    this.paintList();
    const { api, lane } = this.deps;
    if (!this.currentBody && this.id) {
      try {
        const rec = unwrapRecord(await api.get(this.id));
        if (rec) {
          this.currentBody = str(rec.body);
          this.record.label = this.record.label || rec.label;
          this.record.updated = this.record.updated || rec.updated;
        }
      } catch (_) { /* the previews still work without it */ }
    }
    let res;
    try {
      res = await lane((signal) => api.versions(this.id, signal));
    } catch (err) {
      if (this.disposed) return;
      this.list = { loading: false, error: "could not load versions: " + errMsg(err) };
      this.paintList();
      return;
    }
    if (res === ABORTED || this.disposed) return;
    this.list = { loading: false, error: "" };
    this.rows = buildRows(this.record, this.currentBody, res?.versions || []);
    this.selected = this.rows.length > 1 ? 1 : 0;
    this.paintList();
    await this.select(this.selected, { force: true });
  }

  paintList() {
    clear(this.listBox);
    this.vlist?.destroy();
    this.vlist = null;
    const { loading, error } = this.list;
    if (loading) return this.listBox.append(h("div", { className: "pl-list-empty" }, "loading versions…"));
    if (error) return this.listBox.append(errorRow(error, () => this.reload()));
    if (!this.rows.length) return this.listBox.append(h("div", { className: "pl-list-empty" }, "no versions yet"));
    const paint = (row, item, i) => paintVersionRow(row, item, i, this.selected);
    if (this.rows.length > VIRTUALISE_AT) {
      const spacer = h("div", { className: "pl-list-spacer" });
      const win = h("div", { className: "pl-list-win" });
      this.listBox.append(spacer, win);
      this.vlist = new VirtualList({
        viewport: this.listBox, spacer, win, createRow: createVersionRow, updateRow: paint,
        source: { get: (i) => this.rows[i] || null, peek: (i) => this.rows[i] || null },
      });
      this.vlist.setTotal(this.rows.length);
      return;
    }
    this.rows.forEach((item, i) => {
      const row = createVersionRow();
      // Plain rows are not virtualised, so --pl-row-h must not clip a long preview.
      row.style.height = "auto";
      row.style.minHeight = "72px";
      paint(row, item, i);
      this.listBox.append(row);
    });
  }

  repaintSelection() {
    if (this.vlist) return this.vlist.repaint();
    for (const row of this.listBox.querySelectorAll(".pl-row")) {
      const on = Number(row.dataset.idx) === this.selected;
      row.setAttribute("aria-selected", String(on));
      cls(row, "is-sel", on);
    }
  }

  onKey(e) {
    if (isTextEntry(e.target)) return;
    const last = this.rows.length - 1;
    const next = { ArrowDown: Math.min(last, this.selected + 1), ArrowUp: Math.max(0, this.selected - 1), Home: 0, End: last }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    if (next === this.selected || !this.rows.length) return;
    this.selected = Math.max(0, Math.min(last, next));
    this.repaintSelection();
    this.vlist?.scrollToIndex(this.selected);
    this.scheduleSelect(this.selected);
  }

  /** Select row `index` and load its body and diff, in one lane run so a
   * superseded selection cannot half-land. */
  async select(index, { force = false } = {}) {
    if (this.disposed) return;
    const i = Math.max(0, Math.min(this.rows.length - 1, Number(index) || 0));
    const changed = i !== this.selected;
    this.selected = i;
    this.repaintSelection();
    this.vlist?.scrollToIndex(i);
    const item = this.rows[i];
    if (!item) return;
    const pane = this.pane;
    if (item.isCurrent) {
      this.pane = { state: "idle", error: "", opcodes: null, version: null };
      return this.paintPane();
    }
    if (!changed && !force && pane.state === "ready" && pane.version?.index === item.index) return this.paintPane();
    const mine = ++this.seq;
    this.pane = { state: "loading", error: "", opcodes: null, version: null };
    this.paintPane();
    const { api, lane } = this.deps;
    let res;
    try {
      res = await lane(async (signal) => {
        const vres = await api.version(this.id, item.index, signal);
        const version = (vres && (vres.version || vres.prompt)) || null;
        const vbody = version ? str(version.body) : "";
        const cres = await api.compare({ a_text: vbody, b_text: this.currentBody }, signal);
        return { version, vbody, cres };
      });
    } catch (err) {
      if (this.disposed || mine !== this.seq) return;
      this.pane = { state: "error", error: "could not load this version: " + errMsg(err), opcodes: null, version: null };
      return this.paintPane();
    }
    if (res === ABORTED || this.disposed || mine !== this.seq) return;
    this.pane = {
      state: "ready",
      error: "",
      version: { ...(res.version || {}), index: item.index, body: res.vbody },
      opcodes: (Array.isArray(res.cres?.diff) && res.cres.diff) || [],
    };
    this.paintPane();
  }

  /** The text of `item` as far as it is known: the current body, or the loaded snapshot. */
  bodyFor(item) {
    if (!item) return "";
    if (item.isCurrent) return this.currentBody;
    return this.pane.version?.index === item.index ? str(this.pane.version.body) : "";
  }

  paintPane() {
    this.diff?.destroy();
    this.diff = null;
    const item = this.rows[this.selected] || null;
    const isCurrent = !item || item.isCurrent;
    const haveBody = this.pane.version?.body != null;
    this.paneTitle.textContent = item ? item.label : "";
    this.paneMeta.textContent = item ? item.meta : "";
    clear(this.paneActs);
    this.paneActs.append(
      btn("Restore", {
        key: "restore", kind: "primary", disabled: isCurrent || this.pane.state !== "ready",
        title: isCurrent ? "this is already the current version" : "snapshots the current body first, then restores this one",
        onClick: () => restore(this, item),
      }),
      btn("Load into node", {
        key: "load", disabled: !isCurrent && !haveBody,
        title: "sends this version to the node WITHOUT saving it — the stored prompt is untouched",
        onClick: () => loadIntoNode(this, item),
      }),
      btn("Copy", {
        key: "copy", disabled: !isCurrent && !haveBody,
        title: "copy this version's text to the clipboard",
        onClick: () => copy(this, item),
      }));
    clear(this.paneBody);
    if (!item) return;
    if (item.isCurrent) {
      this.paneBody.append(
        h("div", { className: "pl-list-empty" }, "this is the current body — pick a snapshot to see what changed"),
        h("div", { className: "pl-diff-col", style: { maxHeight: "40vh" } }, this.currentBody));
    } else if (this.pane.state === "loading") {
      this.paneBody.append(h("div", { className: "pl-diff" }, skeleton(3), skeleton(3)));
    } else if (this.pane.state === "error") {
      this.paneBody.append(errorRow(this.pane.error, () => this.select(this.selected, { force: true })));
    } else if (this.pane.state === "ready") {
      this.paintDiff(item);
    }
  }

  paintDiff(item) {
    const mode = this.deps.isNarrow() ? "unified" : "split";
    const labels = h("div", { className: "pl-diff" }, h("div", { className: "pl-lbl" }, item.label), h("div", { className: "pl-lbl" }, "current"));
    // Inline display: the .pl-diff grid would override the browser's [hidden] rule.
    labels.style.display = mode === "unified" ? "none" : "";
    const box = h("div", { style: { minHeight: "0" } });
    this.paneBody.append(labels, box);
    this.diff = new DiffView({ opcodes: this.pane.opcodes, a: str(this.pane.version?.body), b: this.currentBody, mode }).mount(box);
  }
}
