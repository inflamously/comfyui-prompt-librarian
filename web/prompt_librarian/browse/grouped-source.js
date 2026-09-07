/* Flatten expanded clusters into fixed-height rows for VirtualList.
 * Remembered group indices belong to one query: reset them on query changes
 * and revalidate IDs after page replacement to avoid stale row offsets.
 */

export const MEMBERS = "__members";

export class GroupedView {
  /** @param {{get:Function, peek:Function, total:number}} source a PagedSource */
  constructor(source) {
    this.source = source;
    /** @type {Map<string, {top: number, extra: number}>} rep id -> its span */
    this.expanded = new Map();
  }


  get busy() {
    return this.source.busy;
  }

  get known() {
    return this.source.known;
  }

  get pages() {
    return this.source.pages;
  }

  /** Records behind the rows — `total` counts rows, which is not the same. */
  get recordTotal() {
    const n = Number(this.source.recordTotal);
    return Number.isFinite(n) && n > 0 ? n : this.source.total;
  }

  load(p) {
    return this.source.load(p);
  }

  reset() {
    this.expanded.clear();
    return this.source.reset();
  }


  /** Drop remembered spans only when their resident representative moved.
   *
   * @returns {Array<{id: string, top: number, extra: number}>}
   */
  spans() {
    const out = [];
    for (const [id, span] of Array.from(this.expanded)) {
      const rec = this.source.peek(span.top);
      // Only judge a span against a page that is actually resident: a hole is
      // "not loaded yet", not "moved".
      if (rec && String(rec.id) !== id) {
        this.expanded.delete(id);
        continue;
      }
      out.push({ id, top: span.top, extra: span.extra });
    }
    out.sort((a, b) => a.top - b.top);
    return out;
  }

  get total() {
    let n = this.source.total;
    for (const s of this.spans()) n += s.extra;
    return n;
  }

  /**
   * @param {number} flat
   * @returns {{top: number, member: number, id: string|null}} `member` is -1
   *   for a top-level row, else the 0-based position within its group.
   */
  locate(flat) {
    let acc = 0;
    for (const s of this.spans()) {
      const at = s.top + acc;
      if (flat < at) break;
      if (flat === at) return { top: s.top, member: -1, id: s.id };
      if (flat <= at + s.extra) return { top: s.top, member: flat - at - 1, id: s.id };
      acc += s.extra;
    }
    return { top: flat - acc, member: -1, id: null };
  }

  toFlat(top) {
    let acc = 0;
    for (const s of this.spans()) {
      if (s.top >= top) break;
      acc += s.extra;
    }
    return top + acc;
  }


  get(flat) {
    return this._at(flat, "get");
  }

  peek(flat) {
    return this._at(flat, "peek");
  }

  _at(flat, how) {
    const loc = this.locate(flat);
    const rec = this.source[how](loc.top);
    if (!rec) return null;
    if (loc.member < 0) return rec;
    return (rec[MEMBERS] || [])[loc.member] || null;
  }

  isMember(flat) {
    return this.locate(flat).member >= 0;
  }

  isOpen(id) {
    return this.expanded.has(String(id));
  }

  membersAt(flat) {
    const loc = this.locate(flat);
    if (loc.member >= 0) return [];
    const rec = this.source.peek(loc.top);
    return (rec && rec[MEMBERS]) || [];
  }

  /** @returns {boolean} whether anything changed — a plain row is not a group.
   */
  toggle(flat) {
    const loc = this.locate(flat);
    if (loc.member >= 0) return false;
    const rec = this.source.peek(loc.top);
    if (!rec || !rec.id) return false;
    const members = rec[MEMBERS] || [];
    if (!members.length) return false;
    const id = String(rec.id);
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.set(id, { top: loc.top, extra: members.length });
    return true;
  }


  /** A collapsed header represents its whole cluster; expanded members select singly.
   */
  idsAt(flat) {
    const loc = this.locate(flat);
    const rec = this.source.peek(loc.top);
    if (!rec) return [];
    if (loc.member >= 0) {
      const m = (rec[MEMBERS] || [])[loc.member];
      return m && m.id ? [String(m.id)] : [];
    }
    const out = rec.id ? [String(rec.id)] : [];
    for (const m of rec[MEMBERS] || []) {
      if (m && m.id) out.push(String(m.id));
    }
    return out;
  }

  async ensureRange(a, b) {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.max(a, b);
    return this.source.ensureRange(this.locate(lo).top, this.locate(hi).top);
  }

  async idsInRange(a, b) {
    await this.ensureRange(a, b);
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.max(a, b);
    const seen = new Set();
    const out = [];
    const end = Math.min(hi, this.total - 1);
    for (let i = lo; i <= end; i++) {
      for (const id of this.idsAt(i)) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }
}

/** Attach the server's sibling groups map to hits once per page, not per scroll.
 * The wire schema keeps group members separate from representative hits.
 *
 * @param {{hits?: any[], groups?: object}} res a /search payload
 * @returns {any[]} the annotated hits
 */
export function attachMembers(res) {
  const hits = (res && Array.isArray(res.hits) && res.hits) || [];
  const groups = (res && res.groups) || {};
  for (const hit of hits) {
    if (!hit || !hit.id) continue;
    const members = groups[String(hit.id)];
    hit[MEMBERS] = Array.isArray(members) ? members : [];
  }
  return hits;
}
