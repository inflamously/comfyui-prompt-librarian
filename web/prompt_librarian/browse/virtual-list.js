/* ==========================================================================
   Prompt Librarian — VirtualList
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   Also used by compare/versions.js for a long snapshot list, which is why it
   is its own file rather than a detail of the rail.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { clear } from "../shared/dom.js";
import { rafThrottle } from "../shared/timing.js";

export const OVERSCAN = 6;
const POOL_CAP = 48;
const ROW_H_FALLBACK = 96;

export class VirtualList {
  /**
   * @param {{
   *   viewport: HTMLElement, spacer: HTMLElement, win: HTMLElement,
   *   overscan?: number,
   *   createRow: () => HTMLElement,
   *   updateRow: (el: HTMLElement, item: any, index: number) => void,
   *   onActivate?: (index: number, ev: Event) => void,
   *   onToggleCheck?: (index: number, checked: boolean, ev: Event) => void,
   *   source?: {get: (i:number) => any, peek: (i:number) => any}
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
