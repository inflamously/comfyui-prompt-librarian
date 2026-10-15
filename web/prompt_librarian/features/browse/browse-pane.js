/* The browse rail: search box, filter chips, sort tabs and the virtualized
 * prompt list. Rows come from the server a page at a time (PagedSource), folded
 * into duplicate clusters (GroupedView). Its root is `display: contents`: the
 * rail is a grid that expects these four parts as its direct children, and an
 * extra box would put the list in an auto-sized row, which disables scrolling
 * and virtualization.
 */

import { ApiError } from "../../api/request.js";
import { Component } from "../../shared/component.js";
import { NO_AUTOFILL, h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { onKey } from "../../shared/keys.js";
import { labelOf, truncate } from "../../shared/text.js";
import { useStyles } from "../../shared/styles.js";
import { debounce } from "../../shared/timing.js";
import { OVERSCAN, VirtualList } from "../../shared/ui/virtual-list.js";
import { FilterChips } from "./filter-chips.js";
import { GroupedView, attachMembers } from "./grouped-source.js";
import { targetIndex } from "./list-keys.js";
import { PAGE_SIZE, PagedSource } from "./paged-source.js";
import { createRow, updateRow } from "./rows.js";
import { searchParams } from "./search-params.js";
import { createSelection } from "./selection.js";
import { SortTabs } from "./sort-tabs.js";

const SKELETON_ROWS = 8;
const SEARCH_DEBOUNCE_MS = 150;

const rowOf = (ev) => {
  const row = ev.target?.closest?.(".pl-row");
  return row && !row.classList.contains("pl-row-skel") && row.dataset.id ? row : null;
};

/**
 * deps: api ({search, get}), slice (browse), tags (the tags service),
 * context() -> {threshold, currentId}, onSelect(id), onLoad(record) -> the
 * result of loading it into the node, toast(message, opts), reportError(err, what).
 */
export class BrowsePane extends Component {
  render() {
    useStyles(new URL("./browse.css", import.meta.url));
    const { slice, tags } = this.deps;
    this.activeIndex = -1;
    this.hits = h("span", { className: "pl-hits" }, "0 hits");
    this.input = h("input", {
      className: "pl-search-in",
      type: "text",
      placeholder: "search prompts and tags  (tag:x  -word  \"phrase\")",
      "aria-label": "Search prompts",
      spellcheck: "false",
      ...NO_AUTOFILL,
    });
    const spacer = h("div", { className: "pl-list-spacer" });
    const win = h("div", { className: "pl-list-win" });
    this.empty = h("div", { className: "pl-list-empty", hidden: true }, "no prompts match");
    this.viewport = h("div", { className: "pl-list", role: "listbox", tabIndex: 0, "aria-label": "Prompts" },
      spacer, win, this.empty);

    this.source = new PagedSource({
      pageSize: PAGE_SIZE,
      fetchPage: (offset, limit) => this.fetchPage(offset, limit),
      onChange: () => { this.sync(); this.vlist.repaint(); },
    });
    this.view = new GroupedView(this.source); // row indices are not record indices
    this.vlist = new VirtualList({
      viewport: this.viewport, spacer, win, overscan: OVERSCAN, source: this.view, createRow,
      updateRow: (row, item, index) => updateRow(row, item, index, this.marks(), this.view),
    });
    this.own(() => this.vlist.destroy());
    this.selection = createSelection({ slice, source: this.view, onChange: () => this.vlist.repaint() });
    this.runSearch = debounce(() => this.refresh(), SEARCH_DEBOUNCE_MS);
    this.own(() => this.runSearch.cancel());

    const setQuery = (patch) => this.setQuery(patch);
    const root = h("div", { className: "pl-browse", style: { display: "contents" } },
      h("div", { className: "pl-search" }, this.input, this.hits));
    this.own(new FilterChips({ slice, tags, setQuery })).mount(root);
    this.own(new SortTabs({ slice, setQuery })).mount(root);
    root.append(this.viewport);

    this.listen(this.input, "input", () => this.onInput());
    this.listen(win, "click", (ev) => this.onClick(ev));
    this.listen(win, "change", (ev) => this.onCheck(ev));
    this.listen(win, "dblclick", (ev) => { const row = rowOf(ev); if (row) this.activate(Number(row.dataset.index)); });
    // The modal's capture guard keeps native key events away; use the key bus.
    this.own(onKey(this.viewport, "keydown", (ev) => this.onKey(ev)));
    this.watch(slice, "selection", () => this.vlist.repaint());
    this.sync();
    return root;
  }

  /** Mount, then re-read the row height: the list could not measure CSS off-DOM. */
  mount(parent) {
    super.mount(parent);
    this.vlist.measure();
    return this;
  }

  /** Reload from the first page; `reset: false` keeps loaded pages and open clusters. */
  async refresh({ reset = true } = {}) {
    if (reset) {
      this.view.reset();
      this.activeIndex = -1;
    }
    this.sync();
    try {
      await this.view.load(0);
    } finally {
      this.sync();
      this.vlist.render();
    }
  }

  /** Replace the typed query, as if the user had typed `text`. */
  search(text) {
    this.input.value = String(text || "");
    this.runSearch.cancel();
    return this.setQuery({ q: this.input.value });
  }

  /** Repaint the visible rows, e.g. after the current prompt changed. */
  repaint() {
    this.vlist.repaint();
  }

  /** Drop a search still waiting out its debounce. */
  cancelPending() {
    this.runSearch.cancel();
  }

  setQuery(patch) {
    const { slice } = this.deps;
    slice.set({ query: { ...slice.get("query"), ...patch } });
    return this.refresh();
  }

  onInput() {
    const { slice } = this.deps;
    const value = this.input.value;
    slice.set({ query: { ...slice.get("query"), q: value } });
    if (value) return this.runSearch();
    // Clearing is an intent, not typing: show everything at once.
    this.runSearch.cancel();
    this.refresh();
  }

  async fetchPage(offset, limit) {
    const { api, slice, context } = this.deps;
    const res = await api.search(searchParams(slice.get("query"), context(), offset, limit));
    if (!res) return { hits: [], total: 0, record_total: 0 };
    attachMembers(res);
    return res;
  }

  /** What a row paints besides its record: the highlight and the checkboxes. */
  marks() {
    const { selection, selectionMode } = this.deps.slice.get();
    return { currentId: this.deps.context().currentId, selection, selectionMode };
  }

  /** Bring the row count, the empty message and the hit count up to date. */
  sync() {
    const view = this.view;
    this.vlist.setTotal(view.known ? view.total : view.busy ? SKELETON_ROWS : 0);
    this.empty.hidden = !(view.known && view.total === 0);
    const q = this.deps.slice.get("query").q;
    this.empty.textContent = q ? `no prompts match "${truncate(q, 40)}"` : "the library is empty";
    const n = view.known ? view.recordTotal : 0;
    this.hits.textContent = `${fmtInt(n)} hit${n === 1 ? "" : "s"}`;
  }

  /** Open or close the cluster at `index`; `force` only opens or only closes. */
  toggleGroup(index, force) {
    const open = this.view.isOpen((this.view.peek(index) || {}).id);
    if ((force === true && open) || (force === false && !open)) return false;
    if (!this.view.toggle(index)) return false;
    this.sync();
    this.vlist.render();
    return true;
  }

  onClick(ev) {
    const row = rowOf(ev);
    if (!row || ev.target === row.__parts.check) return; // the checkbox has its own "change"
    const index = Number(row.dataset.index);
    // The twisty only folds; a click anywhere else on the row folds and selects.
    if (ev.target === row.__parts.twisty) {
      ev.preventDefault();
      this.toggleGroup(index);
    } else if (ev.shiftKey) {
      ev.preventDefault();
      this.selection.selectRange(index);
    } else if (ev.ctrlKey || ev.metaKey) {
      this.selection.toggleRow(index, !this.deps.slice.get("selection").has(row.dataset.id));
    } else {
      this.activeIndex = index;
      this.deps.slice.set({ anchorIndex: index });
      this.deps.onSelect(row.dataset.id);
      this.toggleGroup(index);
      this.vlist.repaint();
    }
  }

  onCheck(ev) {
    const box = ev.target;
    if (!box?.classList?.contains("pl-row-check")) return;
    const row = rowOf(ev);
    if (!row) return;
    const index = Number(row.dataset.index);
    this.deps.slice.set({ anchorIndex: index });
    this.selection.toggleRow(index, !!box.checked); // a collapsed cluster ticks every member
  }

  onKey(ev) {
    const index = this.activeIndex;
    if (!this.vlist.total) return;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      // Only clusters use these; elsewhere they fall through to the browser.
      if (this.toggleGroup(index, ev.key === "ArrowRight")) ev.preventDefault();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      this.activate(index);
      return;
    }
    if (ev.key === " " || ev.key === "Spacebar") {
      ev.preventDefault(); // or the page scrolls
      const rec = this.view.peek(index);
      if (rec?.id) this.selection.toggleRow(index, !this.deps.slice.get("selection").has(String(rec.id)));
      return;
    }
    const next = targetIndex(ev.key, index, this.vlist.total, Math.max(1, this.vlist.visibleCount() - 4));
    if (next == null) return;
    ev.preventDefault();
    this.moveTo(next);
  }

  moveTo(index) {
    this.activeIndex = index;
    this.vlist.scrollToIndex(index, "auto");
    this.deps.slice.set({ anchorIndex: index });
    const rec = this.view.peek(index);
    if (rec?.id) this.deps.onSelect(String(rec.id));
    this.vlist.repaint();
    const row = this.vlist.live.get(index);
    if (row?.id) this.viewport.setAttribute("aria-activedescendant", row.id);
  }

  /** Load the row's full record into the targeted node and say how it went. */
  async activate(index) {
    const { api, onLoad, toast, reportError } = this.deps;
    const rec = this.view.peek(index);
    if (!rec?.id) return;
    try {
      // The list only carries a preview, so the full body has to be fetched.
      const full = await api.get(String(rec.id));
      const record = (full && (full.prompt || full.record || full)) || null;
      if (!record || record.body == null) throw new ApiError(0, null, "bad_record");
      const res = onLoad(record);
      const label = labelOf({ label: full?.label || rec.label, body: record.body }) || "prompt";
      if (res.ok && res.unchanged) toast(`"${label}" is already loaded`, { kind: "info" });
      else if (res.ok) toast(`loaded "${label}" into the node`, { kind: "success" });
      else if (res.reason === "stale_target") toast("that node is gone — pick another target", { kind: "error" });
      else toast("could not load into the node", { kind: "error" });
    } catch (err) {
      reportError(err, "load");
    }
  }
}
