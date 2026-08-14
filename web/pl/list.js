/* ==========================================================================
   Prompt Librarian — browser rail + virtualised list
   --------------------------------------------------------------------------
   INERT ON IMPORT. ComfyUI imports every .js under WEB_DIRECTORY as an
   extension, so this file is evaluated whether or not anything imports it.
   Exports and `const` data only at module scope.

   Owns the left rail from the spec image: search + live hit count, filter
   chips, `dupes only`, sort tabs, the virtualised list, the footer/bulk bar.

   ALL SEARCH IS SERVER-AUTHORITATIVE. There is no local filtering anywhere in
   this file, and adding some would be a bug rather than an optimisation: the
   `96% match` and `N near-dupes` badges are computed by the backend for the
   current page, and a locally-filtered list would show rows whose badges
   disagree with the list they are in.
   ========================================================================== */

import {
  NS,
  NO_AUTOFILL,
  clear,
  debounce,
  firstLine,
  fmtInt,
  h,
  rafThrottle,
  relTime,
  truncate,
} from "./dom.js";

const PAGE_SIZE = 200;
const OVERSCAN = 6;
const POOL_CAP = 48;
const ROW_H_FALLBACK = 96;
const SKELETON_ROWS = 8;
const SEARCH_DEBOUNCE_MS = 150;
const MULT = String.fromCharCode(0x00d7); // "×"
const MIDDOT = String.fromCharCode(0x00b7); // "·"
const TIMES = String.fromCharCode(0x00d7);
const NDASH = String.fromCharCode(0x2013); // "–", as in "a–z"

const SORTS = [
  { key: "relevance", label: "relevance" },
  { key: "recent", label: "recent" },
  { key: "most_used", label: "most used" },
  { key: "az", label: "a" + NDASH + "z" },
];

/* ==========================================================================
   PagedSource — 200 records per page, holes render as skeletons
   ========================================================================== */

export class PagedSource {
  /**
   * @param {{pageSize?: number, fetchPage: (offset:number, limit:number) => Promise<{hits:any[], total:number}>, onChange?: () => void}} opts
   */
  constructor(opts) {
    this.pageSize = opts.pageSize || PAGE_SIZE;
    this.fetchPage = opts.fetchPage;
    this.onChange = opts.onChange || (() => {});
    this.pages = new Map(); // pageIndex -> item[]
    this.inflight = new Map(); // pageIndex -> Promise
    this.total = 0;
    this.known = false; // has any page landed?
    this.epoch = 0;
  }

  /** Invalidate everything. In-flight pages from older epochs are discarded. */
  reset() {
    this.epoch++;
    this.pages.clear();
    this.inflight.clear();
    this.total = 0;
    this.known = false;
  }

  get busy() {
    return this.inflight.size > 0;
  }

  pageOf(i) {
    return Math.floor(i / this.pageSize);
  }

  /**
   * The record at `i`, or `null` when its page is not loaded yet (the caller
   * renders a skeleton row and the page load repaints it).
   */
  get(i) {
    if (i < 0) return null;
    const p = this.pageOf(i);
    const page = this.pages.get(p);
    if (page) return page[i - p * this.pageSize] || null;
    this.load(p);
    return null;
  }

  /** Already-resident record, without triggering a fetch. */
  peek(i) {
    const page = this.pages.get(this.pageOf(i));
    return page ? page[i - this.pageOf(i) * this.pageSize] || null : null;
  }

  load(p) {
    if (this.pages.has(p) || this.inflight.has(p)) return this.inflight.get(p) || Promise.resolve();
    const epoch = this.epoch;
    const promise = Promise.resolve()
      .then(() => this.fetchPage(p * this.pageSize, this.pageSize))
      .then((res) => {
        // Epoch guard: a reset() happened while this was in flight, so this
        // page belongs to a query nobody is looking at any more.
        if (epoch !== this.epoch) return;
        const hits = (res && Array.isArray(res.hits) && res.hits) || [];
        this.pages.set(p, hits);
        this.total = Number(res && res.total) || hits.length;
        this.known = true;
        this.onChange();
      })
      .catch((err) => {
        if (epoch !== this.epoch) return;
        console.error(`${NS} page ${p} failed`, err);
        this.pages.set(p, []); // stop hammering a failing endpoint
        this.known = true;
        this.onChange();
      })
      .finally(() => {
        if (epoch === this.epoch) this.inflight.delete(p);
      });
    this.inflight.set(p, promise);
    return promise;
  }

  /**
   * Guarantee every index in [a, b] is resident. This is what makes
   * shift-click ranges work across the virtualisation boundary — the rows in
   * the middle of the range have never been rendered, so their ids are not in
   * the DOM and must be fetched before the range can be turned into ids.
   */
  async ensureRange(a, b) {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.max(a, b);
    const wanted = [];
    for (let p = this.pageOf(lo); p <= this.pageOf(hi); p++) {
      if (!this.pages.has(p)) wanted.push(this.load(p));
    }
    if (wanted.length) await Promise.all(wanted);
  }

  /** Ids for an index range, in order. Loads what is missing. */
  async idsInRange(a, b) {
    await this.ensureRange(a, b);
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.total - 1, Math.max(a, b));
    const out = [];
    for (let i = lo; i <= hi; i++) {
      const rec = this.peek(i);
      if (rec && rec.id) out.push(String(rec.id));
    }
    return out;
  }
}

/* ==========================================================================
   VirtualList
   ========================================================================== */

export class VirtualList {
  /**
   * @param {{
   *   viewport: HTMLElement, spacer: HTMLElement, win: HTMLElement,
   *   overscan?: number,
   *   createRow: () => HTMLElement,
   *   updateRow: (el: HTMLElement, item: any, index: number) => void,
   *   onActivate?: (index: number, ev: Event) => void,
   *   onToggleCheck?: (index: number, checked: boolean, ev: Event) => void,
   *   source?: PagedSource
   * }} opts
   */
  constructor(opts) {
    this.viewport = opts.viewport;
    this.spacer = opts.spacer;
    this.win = opts.win;
    this.overscan = opts.overscan == null ? OVERSCAN : opts.overscan;
    this.createRow = opts.createRow;
    this.updateRow = opts.updateRow;
    this.onActivate = opts.onActivate || null;
    this.onToggleCheck = opts.onToggleCheck || null;
    this.source = opts.source || null;

    this.total = 0;
    this.start = 0;
    this.end = 0;
    this.live = new Map(); // index -> element
    this.pool = [];
    this.destroyed = false;

    // Row height comes from CSS (`--pl-row-h`), never from a constant here:
    // the spacer height, the translateY and the stylesheet must agree or the
    // list drifts a little further out of place with every screen of scroll.
    this.rowH = readRowHeight(this.viewport) || ROW_H_FALLBACK;

    this.onScroll = rafThrottle(() => this.render());
    this.viewport.addEventListener("scroll", this.onScroll, { passive: true });
  }

  setSource(source) {
    this.source = source;
  }

  setTotal(n) {
    this.total = Math.max(0, Number(n) || 0);
    this.render();
  }

  /** Re-read the row height (call after a theme/zoom change). */
  measure() {
    const h2 = readRowHeight(this.viewport);
    if (h2 && h2 !== this.rowH) {
      this.rowH = h2;
      this.render();
    }
  }

  visibleCount() {
    const vh = this.viewport.clientHeight || 600;
    return Math.ceil(vh / this.rowH) + this.overscan * 2;
  }

  render() {
    if (this.destroyed) return;
    const rowH = this.rowH;
    const total = this.total;

    this.spacer.style.height = `${total * rowH}px`;

    const scrollTop = this.viewport.scrollTop || 0;
    const vh = this.viewport.clientHeight || 600;
    let start = Math.floor(scrollTop / rowH) - this.overscan;
    if (start < 0) start = 0;
    let end = Math.ceil((scrollTop + vh) / rowH) + this.overscan;
    if (end > total) end = total;
    if (end < start) end = start;

    this.start = start;
    this.end = end;
    this.win.style.transform = `translateY(${start * rowH}px)`;

    // Recycle anything that scrolled out of the window.
    for (const [index, el] of Array.from(this.live)) {
      if (index >= start && index < end) continue;
      this.live.delete(index);
      if (el.parentNode) el.parentNode.removeChild(el);
      if (this.pool.length < POOL_CAP) this.pool.push(el);
    }

    for (let i = start; i < end; i++) {
      let el = this.live.get(i);
      if (!el) {
        el = this.pool.pop() || this.createRow();
        this.live.set(i, el);
        this.win.appendChild(el);
      }
      // Order inside the window does not matter: every row is absolutely
      // placed by its own translateY, so appending recycled nodes at the end
      // is correct and avoids an insertBefore per row.
      el.style.transform = `translateY(${(i - start) * rowH}px)`;
      const item = this.source ? this.source.get(i) : null;
      try {
        this.updateRow(el, item, i);
      } catch (err) {
        console.error(`${NS} updateRow failed`, err);
      }
    }
  }

  /** Repaint the currently mounted rows without changing the window. */
  repaint() {
    for (const [i, el] of this.live) {
      const item = this.source ? this.source.peek(i) : null;
      try {
        this.updateRow(el, item, i);
      } catch (err) {
        console.error(`${NS} updateRow failed`, err);
      }
    }
  }

  /** @param {"auto"|"start"|"center"} [align] */
  scrollToIndex(i, align = "auto") {
    const rowH = this.rowH;
    const vh = this.viewport.clientHeight || 600;
    const top = i * rowH;
    const cur = this.viewport.scrollTop || 0;
    let next = cur;
    if (align === "start") next = top;
    else if (align === "center") next = top - vh / 2 + rowH / 2;
    else if (top < cur) next = top;
    else if (top + rowH > cur + vh) next = top + rowH - vh;
    else return;
    this.viewport.scrollTop = Math.max(0, Math.round(next));
    this.render();
  }

  destroy() {
    this.destroyed = true;
    if (this.onScroll && this.onScroll.cancel) this.onScroll.cancel();
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.live.clear();
    this.pool.length = 0;
    clear(this.win);
  }
}

function readRowHeight(el) {
  try {
    if (typeof getComputedStyle !== "function" || !el) return 0;
    const raw = getComputedStyle(el).getPropertyValue("--pl-row-h");
    const n = parseFloat(String(raw || "").trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

/* ==========================================================================
   mountList
   ========================================================================== */

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
    placeholder: "search name, body, tags" + "  (tag:x  cat:x  -word  \"phrase\")",
    "aria-label": "Search prompts",
    spellcheck: "false",
    ...NO_AUTOFILL,
  });
  const search = h("div", { className: "pl-search" }, input, hits);

  /* ---- 2. filter chips -------------------------------------------------- */
  const chips = h("div", { className: "pl-chips" });

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
  el.appendChild(chips);
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
    updateRow,
  });

  async function fetchPage(offset, limit) {
    const q = st().query;
    const params = {
      q: q.q || "",
      category: q.category || null,
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

  /* ---- rows ------------------------------------------------------------- */

  function createRow() {
    const row = h(
      "div",
      { className: "pl-row", role: "option", "aria-selected": "false", tabIndex: -1 },
      h("span", { className: "pl-row-bar" }),
      h("input", {
        className: "pl-row-check",
        type: "checkbox",
        tabIndex: -1,
        "aria-label": "Select prompt",
      }),
      h(
        "div",
        { className: "pl-row-name" },
        h("span", { className: "pl-row-nm" }),
        h("span", { className: "pl-row-match", hidden: true })
      ),
      h("div", { className: "pl-badge-dupe", hidden: true }),
      h("div", { className: "pl-row-body" }),
      h("div", { className: "pl-row-meta" })
    );
    // Cache the parts so updateRow never queries the DOM. Recycled rows are
    // updated on every scroll frame; a querySelector per field per row is the
    // difference between a smooth list and a janky one.
    // Rows are absolutely placed inside the window so a recycled node can be
    // appended at the end without appearing out of order.
    row.style.position = "absolute";
    row.style.left = "0";
    row.style.right = "0";
    row.style.top = "0";
    row.__parts = {
      check: row.children[1],
      name: row.children[2].children[0],
      match: row.children[2].children[1],
      badge: row.children[3],
      body: row.children[4],
      meta: row.children[5],
    };
    return row;
  }

  /**
   * textContent ONLY. Never innerHTML after creation: it is both the XSS
   * defence for user-authored prompt bodies and the reason recycling is fast
   * (assigning textContent on an existing node skips the HTML parser).
   */
  function updateRow(row, item, index) {
    const p = row.__parts;
    row.dataset.index = String(index);

    if (!item) {
      row.classList.add("pl-row-skel");
      row.removeAttribute("data-id");
      row.setAttribute("aria-selected", "false");
      p.name.textContent = "";
      p.body.textContent = "";
      p.meta.textContent = "";
      p.match.hidden = true;
      p.badge.hidden = true;
      p.check.checked = false;
      return;
    }

    row.classList.remove("pl-row-skel");
    const id = String(item.id || "");
    row.dataset.id = id;
    row.id = "pl-r-" + id;

    p.name.textContent = item.name || "(unnamed)";

    const pct = item.match_pct;
    if (typeof pct === "number" && pct > 0) {
      p.match.textContent = `${Math.round(pct)}% match`;
      p.match.hidden = false;
    } else {
      p.match.hidden = true;
      p.match.textContent = "";
    }

    const dupes = Number(item.dupe_count) || 0;
    if (dupes > 0) {
      p.badge.textContent = `${dupes} near-dupe${dupes === 1 ? "" : "s"}`;
      p.badge.hidden = false;
    } else {
      p.badge.hidden = true;
      p.badge.textContent = "";
    }

    p.body.textContent = firstLine(item.preview || item.body || "", 180);

    const bits = [];
    if (item.category) bits.push(item.category);
    bits.push(`used ${fmtInt(item.used || 0)}${MULT}`);
    const when = relTime(item.last_run || item.updated);
    if (when) bits.push(when);
    p.meta.textContent = bits.join(` ${MIDDOT} `);

    const state = st();
    row.setAttribute("aria-selected", state.currentId && state.currentId === id ? "true" : "false");
    p.check.checked = state.selectionMode === "filter" || state.selection.has(id);
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
      selectRange(index);
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      toggleId(id, !st().selection.has(id));
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
    toggleId(row.dataset.id, !!box.checked);
  });

  win.addEventListener("dblclick", (ev) => {
    const row = ev.target && ev.target.closest ? ev.target.closest(".pl-row") : null;
    if (row && row.dataset.id) activate(Number(row.dataset.index));
  });

  /* ---- keyboard ---------------------------------------------------------
     Registered through ctx.onKey, NOT addEventListener: the modal's
     window-capture guard stops key events before they reach this subtree (see
     the KEY ISOLATION block in modal.js). A plain listener here would simply
     never fire.
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
        if (rec && rec.id) toggleId(String(rec.id), !st().selection.has(String(rec.id)));
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

  /* ---- selection --------------------------------------------------------- */

  function toggleId(id, on) {
    const state = st();
    const sel = state.selection;
    if (state.selectionMode === "filter") {
      // Leaving "all filtered" turns the abstract selection back into ids.
      ctx.setState({ selectionMode: "ids" }, { silent: true });
      sel.clear();
    }
    if (on) sel.add(id);
    else sel.delete(id);
    ctx.setState({ selection: sel, selectionMode: "ids" });
    paintBulk();
    vlist.repaint();
  }

  async function selectRange(index) {
    const anchor = st().anchorIndex;
    if (anchor == null) {
      const rec = source.peek(index);
      if (rec && rec.id) toggleId(String(rec.id), true);
      ctx.setState({ anchorIndex: index }, { silent: true });
      return;
    }
    // ensureRange first: the middle of the range has never been rendered, so
    // its ids do not exist anywhere on the client yet.
    const ids = await source.idsInRange(anchor, index);
    const sel = st().selection;
    for (const id of ids) sel.add(id);
    ctx.setState({ selection: sel, selectionMode: "ids" });
    paintBulk();
    vlist.repaint();
  }

  function clearSelection() {
    const sel = st().selection;
    sel.clear();
    ctx.setState({ selection: sel, selectionMode: "ids" });
    paintBulk();
    vlist.repaint();
  }

  function selectAllFiltered() {
    const sel = st().selection;
    sel.clear();
    // The QUERY is stored, not 1 284 ids — the only shape that scales, and the
    // bulk endpoints accept `{query}` for exactly this reason.
    ctx.setState({ selection: sel, selectionMode: "filter" });
    paintBulk();
    vlist.repaint();
  }

  function currentSel() {
    const state = st();
    if (state.selectionMode === "filter") return { query: queryForServer() };
    return { ids: Array.from(state.selection) };
  }

  function queryForServer() {
    const q = st().query;
    return {
      q: q.q || "",
      category: q.category || null,
      tags: q.tags || [],
      dupes_only: !!q.dupesOnly,
    };
  }

  function selectionCount() {
    const state = st();
    return state.selectionMode === "filter" ? source.total : state.selection.size;
  }

  /** First five names, for the confirm text. Loaded pages only, by design. */
  function selectionNames(limit = 5) {
    const state = st();
    const out = [];
    if (state.selectionMode === "filter") {
      for (let i = 0; i < source.total && out.length < limit; i++) {
        const rec = source.peek(i);
        if (rec && rec.name) out.push(rec.name);
      }
      return out;
    }
    const wanted = new Set(state.selection);
    for (let i = 0; i < source.total && out.length < limit; i++) {
      const rec = source.peek(i);
      if (rec && wanted.has(String(rec.id))) out.push(rec.name || rec.id);
    }
    return out;
  }

  function describeSelection() {
    const n = selectionCount();
    const names = selectionNames(5);
    const more = n > names.length ? `\n… and ${fmtInt(n - names.length)} more` : "";
    return `${fmtInt(n)} prompt${n === 1 ? "" : "s"}:\n${names.map((s) => `  ${s}`).join("\n")}${more}`;
  }

  /* ---- bulk bar ---------------------------------------------------------- */

  function paintBulk() {
    clear(bulkbar);
    const n = selectionCount();
    if (!n) {
      // The spec's footer line. Same row as the bulk bar so `.pl-rail` keeps
      // exactly five children.
      bulkbar.appendChild(h("span", null, `scroll ${MIDDOT} virtualised list`));
      return;
    }
    const mode = st().selectionMode;
    bulkbar.appendChild(
      h("span", null, `${fmtInt(n)} selected${mode === "filter" ? " (all filtered)" : ""}`)
    );
    if (mode !== "filter" && source.total > n) {
      bulkbar.appendChild(
        h(
          "button",
          { className: "pl-btn pl-btn-ghost pl-btn-sm", type: "button", onclick: selectAllFiltered },
          "select all filtered"
        )
      );
    }
    bulkbar.appendChild(
      h("button", { className: "pl-btn pl-btn-ghost pl-btn-sm", type: "button", onclick: clearSelection }, "clear")
    );
    bulkbar.appendChild(h("span", { className: "pl-spacer" }));
    bulkbar.appendChild(
      h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: bulkCategorize }, "categorize")
    );
    bulkbar.appendChild(
      h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: bulkRetag }, "retag")
    );
    bulkbar.appendChild(
      h("button", { className: "pl-btn pl-btn-sm pl-btn-danger", type: "button", onclick: bulkDelete }, "delete")
    );
  }

  async function afterBulk(msg) {
    ctx.invalidateMeta();
    clearSelection();
    await ctx.refreshAll();
    if (msg) ctx.toast(msg, { kind: "success" });
  }

  async function bulkDelete() {
    const n = selectionCount();
    if (!n) return;
    const ok = await ctx.confirmDialog({
      title: `Delete ${fmtInt(n)} prompt${n === 1 ? "" : "s"}?`,
      message: `This cannot be undone.\n\n${describeSelection()}`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.API.bulkDelete(currentSel());
      await afterBulk(`deleted ${fmtInt(n)} prompt${n === 1 ? "" : "s"}`);
    } catch (err) {
      ctx.reportError(err, "bulk delete");
    }
  }

  async function bulkCategorize() {
    const n = selectionCount();
    if (!n) return;
    const category = await pickOne(
      "Move to category",
      st().categories.map((c) => c.name)
    );
    if (!category) return;
    try {
      await ctx.API.bulkCategorize(currentSel(), category);
      await afterBulk(`moved ${fmtInt(n)} to ${category}`);
    } catch (err) {
      ctx.reportError(err, "bulk categorize");
    }
  }

  async function bulkRetag() {
    const n = selectionCount();
    if (!n) return;
    const tag = await pickOne(
      "Add tag",
      st().tags.map((t) => t.name),
      { allowNew: true }
    );
    if (!tag) return;
    try {
      await ctx.API.bulkRetag(currentSel(), [tag], []);
      await afterBulk(`tagged ${fmtInt(n)} with ${tag}`);
    } catch (err) {
      ctx.reportError(err, "bulk retag");
    }
  }

  /* ---- chips ------------------------------------------------------------- */

  function paintChips() {
    clear(chips);
    const q = st().query;

    if (q.category) {
      chips.appendChild(
        h(
          "span",
          { className: "pl-chip is-on" },
          h("span", null, q.category),
          h(
            "button",
            {
              className: "pl-chip-x",
              type: "button",
              "aria-label": `Clear category ${q.category}`,
              onclick: () => setQuery({ category: null }),
            },
            TIMES
          )
        )
      );
    }
    for (const tag of q.tags) {
      chips.appendChild(
        h(
          "span",
          { className: "pl-chip is-on" },
          h("span", null, tag),
          h(
            "button",
            {
              className: "pl-chip-x",
              type: "button",
              "aria-label": `Clear tag ${tag}`,
              onclick: () => setQuery({ tags: q.tags.filter((t) => t !== tag) }),
            },
            TIMES
          )
        )
      );
    }
    chips.appendChild(
      h(
        "button",
        { className: "pl-chip pl-chip-add", type: "button", onclick: pickCategory },
        h("span", null, "+ category")
      )
    );
    chips.appendChild(
      h("button", { className: "pl-chip pl-chip-add", type: "button", onclick: pickTag }, h("span", null, "+ tag"))
    );
    chips.appendChild(
      h(
        "button",
        {
          className: "pl-chip pl-chip-toggle" + (q.dupesOnly ? " is-on" : ""),
          type: "button",
          "aria-pressed": q.dupesOnly ? "true" : "false",
          onclick: () => setQuery({ dupesOnly: !st().query.dupesOnly }),
        },
        h("span", null, "dupes only")
      )
    );
  }

  async function pickCategory() {
    const name = await pickOne(
      "Filter by category",
      st().categories.map((c) => c.name)
    );
    if (name) setQuery({ category: name });
  }

  async function pickTag() {
    const name = await pickOne(
      "Filter by tag",
      st().tags.map((t) => t.name)
    );
    if (!name) return;
    const tags = st().query.tags.slice();
    if (!tags.includes(name)) tags.push(name);
    setQuery({ tags });
  }

  /**
   * One-of picker. Uses pickers.js when it exists (owned by a later wave) and
   * otherwise falls back to a self-contained popover, so the rail is fully
   * usable before that module lands.
   * @returns {Promise<string|null>}
   */
  async function pickOne(title, options, opts = {}) {
    try {
      const mod = await import("./pickers.js");
      if (typeof mod.openPicker === "function") {
        return await mod.openPicker({ title, options, ...opts, ctx });
      }
    } catch (_) {
      /* not landed yet — fall through to the built-in */
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        ctx.popLayer(handle);
        resolve(val);
      };
      const pop = h("div", { className: "pl-popover", role: "listbox", "aria-label": title });
      if (opts.allowNew) {
        const field = h("input", {
          className: "pl-name",
          type: "text",
          spellcheck: "false",
          ...NO_AUTOFILL,
          placeholder: "new " + title.toLowerCase(),
          "aria-label": title,
        });
        ctx.onKey(field, "keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            const v = String(field.value || "").trim();
            if (v) finish(v);
          }
        });
        pop.appendChild(field);
      }
      if (!options.length) pop.appendChild(h("div", { className: "pl-opt" }, "(none yet)"));
      for (const opt of options) {
        pop.appendChild(
          h("button", { className: "pl-opt", type: "button", role: "option", onclick: () => finish(opt) }, opt)
        );
      }
      pop.style.left = "50%";
      pop.style.top = "20%";
      const handle = ctx.pushLayer({ el: pop, closeOnOutside: true, onClose: () => finish(null) });
      if (!handle) resolve(null);
    });
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
    paintChips();
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

  const offTaxonomy = ctx.subscribe("categories", () => paintChips());
  const offCurrent = ctx.subscribe("current", () => vlist.repaint());
  // `currentId` is set the instant a row is clicked (before the record has
  // loaded), so the accent bar never lags a request behind the click.
  const offCurrentId = ctx.subscribe("currentId", () => vlist.repaint());
  const offSelection = ctx.subscribe("selection", () => paintBulk());

  paintChips();
  paintTabs();
  paintBulk();
  syncTotal();
  paintHits();

  const handle = {
    refresh,
    reset: () => source.reset(),
    source,
    vlist,
    scrollToIndex: (i, align) => vlist.scrollToIndex(i, align),
    setQuery,
    selectAllFiltered,
    clearSelection,
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

/* Kept for callers that only want the row markup (the compare dialog reuses
   the same shape). Not used above; exported so it cannot drift silently. */
export const ROW_CLASSES = Object.freeze({
  row: "pl-row",
  skeleton: "pl-row-skel",
  selectedBar: "pl-row-bar",
});
