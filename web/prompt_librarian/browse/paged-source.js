import { NS } from "../shared/ns.js";

export const PAGE_SIZE = 200;

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
    // total counts folded rows; recordTotal counts records affected by bulk queries.
    this.recordTotal = 0;
    this.known = false; // has any page landed?
    this.epoch = 0;
  }

  /** Invalidate everything. In-flight pages from older epochs are discarded. */
  reset() {
    this.epoch++;
    this.pages.clear();
    this.inflight.clear();
    this.total = 0;
    this.recordTotal = 0;
    this.known = false;
  }

  get busy() {
    return this.inflight.size > 0;
  }

  pageOf(i) {
    return Math.floor(i / this.pageSize);
  }

  /** Return null for unloaded pages; callers display skeletons until repaint.
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
        // Discard responses from queries invalidated by reset().
        if (epoch !== this.epoch) return;
        const hits = (res && Array.isArray(res.hits) && res.hits) || [];
        this.pages.set(p, hits);
        this.total = Number(res && res.total) || hits.length;
        this.recordTotal = Number(res && res.record_total) || this.total;
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

  /** Load the whole range before shift-selection; off-screen IDs are not in the DOM.
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
