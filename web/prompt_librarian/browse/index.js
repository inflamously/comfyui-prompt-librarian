/* ==========================================================================
   Prompt Librarian — the browser rail
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Exports and `const` data only.

   Owns the left rail from the spec image: search + live hit count, filter
   chips, `dupes only`, sort tabs, the virtualised list, the footer/bulk bar.
   Each of those is its own file here; this one assembles them.

   ALL SEARCH IS SERVER-AUTHORITATIVE. There is no local filtering anywhere in
   this feature, and adding some would be a bug rather than an optimisation:
   the `96% match` and `N near-dupes` badges are computed by the backend for
   the current page, and a locally-filtered list would show rows whose badges
   disagree with the list they are in.
   ========================================================================== */

import { NO_AUTOFILL, clear, h } from "../shared/dom.js";
import { debounce } from "../shared/timing.js";
import { truncate } from "../shared/text.js";
import { fmtInt } from "../shared/format.js";
import { PAGE_SIZE, PagedSource } from "./paged-source.js";
import { OVERSCAN, VirtualList } from "./virtual-list.js";
import { createRow, updateRow } from "./rows.js";
import { createSelection } from "./selection.js";
import { createBulkBar } from "./bulk.js";
import { createChips } from "./chips.js";

const SKELETON_ROWS = 8;
const SEARCH_DEBOUNCE_MS = 150;
const NDASH = String.fromCharCode(0x2013); // "–", as in "a–z"

const SORTS = [
  { key: "relevance", label: "relevance" },
  { key: "recent", label: "recent" },
  { key: "most_used", label: "most used" },
  { key: "az", label: "a" + NDASH + "z" },
];

/**
 * Build the rail into `el` (the `.pl-rail` grid) and wire it to `ctx`.
 *
 * `.pl-rail` is `grid-template-rows: auto auto auto minmax(0,1fr) auto`, so it
 * must have EXACTLY these five children in this order — a sixth would push the
 * list into an `auto` row, and an auto-sized scroll container grows to fit its
 * content instead of scrolling, which silently disables virtualisation.
 *
 * @returns {object} the same handle that is registered as `ctx.list`
 */
export function mountList(el, ctx) {
  clear(el);

  /* ---- 1. search ------------------------------------------------------- */
  const hits = h("span", { className: "pl-hits" }, "0 hits");
  const input = h("input", {
    className: "pl-search-in",
    type: "text",
    placeholder: "search name, body, tags" + "  (tag:x  -word  \"phrase\")",
    "aria-label": "Search prompts",
    spellcheck: "false",
    ...NO_AUTOFILL,
  });
  const search = h("div", { className: "pl-search" }, input, hits);

  /* ---- 2. filter chips -------------------------------------------------- */
  const chipsEl = h("div", { className: "pl-chips" });

  /* ---- 3. sort tabs ----------------------------------------------------- */
  const tabs = h("div", { className: "pl-tabs", role: "tablist", "aria-label": "Sort" });
  const tabEls = new Map();
  for (const sort of SORTS) {
    const tab = h(
      "button",
      {
        className: "pl-tab",
        type: "button",
        role: "tab",
        "aria-selected": sort.key === "relevance" ? "true" : "false",
        dataset: { sort: sort.key },
        onclick: () => setQuery({ sort: sort.key }), // intent click: no debounce
      },
      sort.label
    );
    tabEls.set(sort.key, tab);
    tabs.appendChild(tab);
  }

  /* ---- 4. the list ------------------------------------------------------ */
  const spacer = h("div", { className: "pl-list-spacer" });
  const win = h("div", { className: "pl-list-win" });
  const empty = h("div", { className: "pl-list-empty", hidden: true }, "no prompts match");
  const viewport = h(
    "div",
    {
      className: "pl-list",
      role: "listbox",
      tabIndex: 0,
      "aria-label": "Prompts",
    },
    spacer,
    win,
    empty
  );

  /* ---- 5. footer / bulk bar --------------------------------------------- */
  const bulkbar = h("div", { className: "pl-bulkbar" });

  el.appendChild(search);
  el.appendChild(chipsEl);
  el.appendChild(tabs);
  el.appendChild(viewport);
  el.appendChild(bulkbar);

  /* ---------------------------------------------------------------------- */

  const st = () => ctx.getState();
  let activeIndex = -1;

  const source = new PagedSource({
    pageSize: PAGE_SIZE,
    fetchPage: (offset, limit) => fetchPage(offset, limit),
    onChange: () => {
      syncTotal();
      vlist.repaint();
      paintHits();
      // Page 0 doubles as the state's `hits` snapshot for the inspector.
      const first = source.pages.get(0);
      if (first) ctx.setState({ hits: first, hitsTotal: source.total, total: st().total || source.total });
    },
  });

  const vlist = new VirtualList({
    viewport,
    spacer,
    win,
    overscan: OVERSCAN,
    source,
    createRow,
    updateRow: (row, item, index) => updateRow(row, item, index, st()),
  });

  const selection = createSelection({
    ctx,
    source,
    onChange: () => {
      bulk.paint();
      vlist.repaint();
    },
  });
  const bulk = createBulkBar({ ctx, el: bulkbar, source, selection });
  const chips = createChips({ ctx, el: chipsEl, setQuery });

  async function fetchPage(offset, limit) {
    const q = st().query;
    const params = {
      q: q.q || "",
      tags: q.tags && q.tags.length ? q.tags : null,
      dupes_only: q.dupesOnly ? true : null,
      sort: q.sort || "relevance",
      offset,
      limit,
      threshold: st().dupes && st().dupes.threshold,
      match_id: st().currentId || null,
    };
    const res = await ctx.API.search(params);
    if (res && res.rev != null) ctx.setState({ rev: res.rev }, { silent: true });
    return res || { hits: [], total: 0 };
  }

  function syncTotal() {
    const total = source.known ? source.total : source.busy ? SKELETON_ROWS : 0;
    vlist.setTotal(total);
    const isEmpty = source.known && source.total === 0;
    empty.hidden = !isEmpty;
    empty.textContent = st().query.q
      ? `no prompts match "${truncate(st().query.q, 40)}"`
      : "the library is empty";
  }

  function paintHits() {
    const n = source.known ? source.total : 0;
    hits.textContent = `${fmtInt(n)} hit${n === 1 ? "" : "s"}`;
  }

  /* ---- row interaction (delegated) --------------------------------------- */

  win.addEventListener("click", (ev) => {
    const row = ev.target && ev.target.closest ? ev.target.closest(".pl-row") : null;
    if (!row || row.classList.contains("pl-row-skel")) return;
    const index = Number(row.dataset.index);
    const id = row.dataset.id;
    if (!id) return;

    if (ev.target === row.__parts.check) return; // handled by "change"

    if (ev.shiftKey) {
      ev.preventDefault();
      selection.selectRange(index);
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      selection.toggleId(id, !st().selection.has(id));
      return;
    }
    activeIndex = index;
    ctx.setState({ anchorIndex: index }, { silent: true });
    ctx.selectPrompt(id);
    vlist.repaint();
  });

  win.addEventListener("change", (ev) => {
    const box = ev.target;
    if (!box || !box.classList || !box.classList.contains("pl-row-check")) return;
    const row = box.closest(".pl-row");
    if (!row || !row.dataset.id) return;
    ctx.setState({ anchorIndex: Number(row.dataset.index) }, { silent: true });
    selection.toggleId(row.dataset.id, !!box.checked);
  });

  win.addEventListener("dblclick", (ev) => {
    const row = ev.target && ev.target.closest ? ev.target.closest(".pl-row") : null;
    if (row && row.dataset.id) activate(Number(row.dataset.index));
  });

  /* ---- keyboard ---------------------------------------------------------
     Registered through ctx.onKey, NOT addEventListener: the modal's
     window-capture guard stops key events before they reach this subtree (see
     the KEY ISOLATION block in modal/keys.js). A plain listener here would
     simply never fire.
     --------------------------------------------------------------------- */
  const offKeys = ctx.onKey(viewport, "keydown", (ev) => {
    const total = vlist.total;
    if (!total) return;
    let next = null;
    switch (ev.key) {
      case "ArrowDown":
        next = Math.min(total - 1, (activeIndex < 0 ? -1 : activeIndex) + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, (activeIndex < 0 ? 1 : activeIndex) - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = total - 1;
        break;
      case "PageDown":
        next = Math.min(total - 1, Math.max(0, activeIndex) + Math.max(1, vlist.visibleCount() - 4));
        break;
      case "PageUp":
        next = Math.max(0, Math.max(0, activeIndex) - Math.max(1, vlist.visibleCount() - 4));
        break;
      case "Enter":
        ev.preventDefault();
        activate(activeIndex);
        return;
      case " ":
      case "Spacebar": {
        ev.preventDefault(); // or the page scrolls under us
        const rec = source.peek(activeIndex);
        if (rec && rec.id) selection.toggleId(String(rec.id), !st().selection.has(String(rec.id)));
        return;
      }
      default:
        return;
    }
    ev.preventDefault();
    moveTo(next);
  });

  function moveTo(index) {
    activeIndex = index;
    vlist.scrollToIndex(index, "auto");
    ctx.setState({ anchorIndex: index }, { silent: true });
    const rec = source.peek(index);
    if (rec && rec.id) ctx.selectPrompt(String(rec.id));
    vlist.repaint();
    const row = vlist.live.get(index);
    if (row && row.id) viewport.setAttribute("aria-activedescendant", row.id);
  }

  /** Enter / double-click: push the record into the target node. */
  async function activate(index) {
    const rec = source.peek(index);
    if (!rec || !rec.id) return;
    try {
      // The list only carries a preview, so the full body has to be fetched.
      const full = await ctx.API.get(String(rec.id));
      const record = (full && (full.prompt || full.record || full)) || null;
      if (!record || record.body == null) throw new ctx.ApiError(0, null, "bad_record");
      const res = ctx.loadIntoNode(record);
      if (res.ok) ctx.toast(`loaded "${record.name || rec.name || "prompt"}" into the node`, { kind: "success" });
      else if (res.reason === "stale_target") ctx.toast("that node is gone — pick another target", { kind: "error" });
      else ctx.toast("could not load into the node", { kind: "error" });
    } catch (err) {
      ctx.reportError(err, "load");
    }
  }

  /* ---- query ------------------------------------------------------------- */

  function paintTabs() {
    const sort = st().query.sort;
    for (const [key, tab] of tabEls) tab.setAttribute("aria-selected", key === sort ? "true" : "false");
  }

  /**
   * Apply a query patch and re-run the search. Chips and tabs are intent
   * clicks and run immediately; only the text input is debounced.
   */
  function setQuery(patch) {
    const q = { ...st().query, ...patch };
    ctx.setState({ query: q });
    chips.paint();
    paintTabs();
    return refresh({ reset: true });
  }

  const runSearch = debounce(() => refresh({ reset: true }), SEARCH_DEBOUNCE_MS);
  if (Array.isArray(ctx.debounces)) ctx.debounces.push(runSearch);

  input.addEventListener("input", () => {
    const value = input.value;
    const q = { ...st().query, q: value };
    ctx.setState({ query: q }, { silent: true });
    if (!value) {
      // Clearing is an intent, not typing: show everything immediately.
      runSearch.cancel();
      refresh({ reset: true });
      return;
    }
    runSearch();
  });

  /* ---- refresh ----------------------------------------------------------- */

  async function refresh(opts = {}) {
    if (opts.reset !== false) {
      source.reset();
      activeIndex = -1;
    }
    ctx.setState({ loading: true }, { silent: true });
    syncTotal();
    paintHits();
    try {
      await source.load(0);
    } finally {
      ctx.setState({ loading: false }, { silent: true });
      syncTotal();
      paintHits();
      vlist.render();
    }
  }

  /* ---- state subscriptions ------------------------------------------------ */

  const offTaxonomy = ctx.subscribe("tags", () => chips.paint());
  const offCurrent = ctx.subscribe("current", () => vlist.repaint());
  // `currentId` is set the instant a row is clicked (before the record has
  // loaded), so the accent bar never lags a request behind the click.
  const offCurrentId = ctx.subscribe("currentId", () => vlist.repaint());
  const offSelection = ctx.subscribe("selection", () => bulk.paint());

  chips.paint();
  paintTabs();
  bulk.paint();
  syncTotal();
  paintHits();

  const handle = {
    refresh,
    reset: () => source.reset(),
    source,
    vlist,
    selection,
    scrollToIndex: (i, align) => vlist.scrollToIndex(i, align),
    setQuery,
    selectAllFiltered: () => selection.selectAllFiltered(),
    clearSelection: () => selection.clear(),
    destroy() {
      offKeys();
      offTaxonomy();
      offCurrent();
      offCurrentId();
      offSelection();
      runSearch.cancel();
      vlist.destroy();
    },
  };
  ctx.list = handle;
  return handle;
}
