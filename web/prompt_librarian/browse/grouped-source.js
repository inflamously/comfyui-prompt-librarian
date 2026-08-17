/* ==========================================================================
   Prompt Librarian — GroupedView
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   The accordion. `PagedSource` pages over what the server returns — with
   `group=true` that is one row per near-duplicate CLUSTER — and this view sits
   on top of it turning "which clusters has the user opened?" into a flat index
   space the virtual list can page over unchanged.

   WHY A FLAT INDEX SPACE AND NOT VARIABLE ROW HEIGHTS
   --------------------------------------------------
   `VirtualList` computes its spacer as `total * --pl-row-h` and places every
   row at `i * rowH`. That is the whole reason it stays smooth. An expanded
   group therefore may not be one *taller* row; it is one row plus N ordinary
   rows, all the same height, and the only thing that changes is what index
   maps to what record. Nothing in VirtualList needed to know about groups.

   THE MAPPING
   -----------
   `expanded` remembers, per open group, the TOP-LEVEL index its header sits at
   and how many members it adds. Flat index -> top-level index is then a walk
   over the open groups in index order, accumulating their extra rows. The set
   is user-sized (you can only open what you can see), so the walk is short
   enough to run inside a scroll frame.

   Those remembered indices are only valid for the query that produced them, so
   `reset()` clears them — and because a page can also be replaced under us
   after a save, every read re-checks that the id still sits where it was
   recorded and drops the entry if not. A stale span self-heals into a plain
   row rather than shuffling the list by one.
   ========================================================================== */

/** Members are attached to their representative hit when a page lands. */
export const MEMBERS = "__members";

export class GroupedView {
  /** @param {{get:Function, peek:Function, total:number}} source a PagedSource */
  constructor(source) {
    this.source = source;
    /** @type {Map<string, {top: number, extra: number}>} rep id -> its span */
    this.expanded = new Map();
  }

  /* -- passthrough, so this can stand in for the PagedSource ---------------- */

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

  /* -- the mapping ---------------------------------------------------------- */

  /**
   * Open groups in top-level index order, dropping any whose representative
   * has moved out from under the index we recorded.
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

  /** Rows the list should page over: top-level rows plus everything opened. */
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

  /** Where a top-level row currently renders. */
  toFlat(top) {
    let acc = 0;
    for (const s of this.spans()) {
      if (s.top >= top) break;
      acc += s.extra;
    }
    return top + acc;
  }

  /* -- reads ---------------------------------------------------------------- */

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

  /** True when `flat` is a member row rather than a top-level one. */
  isMember(flat) {
    return this.locate(flat).member >= 0;
  }

  isOpen(id) {
    return this.expanded.has(String(id));
  }

  /** Members carried by the row at `flat`, or `[]`. */
  membersAt(flat) {
    const loc = this.locate(flat);
    if (loc.member >= 0) return [];
    const rec = this.source.peek(loc.top);
    return (rec && rec[MEMBERS]) || [];
  }

  /**
   * Open or close the group at `flat`.
   * @returns {boolean} whether anything changed — a plain row is not a group.
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

  /* -- selection ------------------------------------------------------------ */

  /**
   * The record ids one row stands for.
   *
   * A COLLAPSED GROUP STANDS FOR ITS WHOLE CLUSTER. Ticking a row that reads
   * "4 copies" and having it select one hidden-arbitrary record of the four
   * would be the same class of lie as the badge this feature exists to fix.
   * Open the group and tick a member to act on exactly one.
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

  /** Ids for a flat range, in order and deduplicated. */
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

/**
 * Hang each representative's members off its hit, in place.
 *
 * The server sends them as a sibling map (`groups[repId]`) because a
 * self-referential hit is not a shape the OpenAPI generator can render; the
 * list wants them on the row. One pass per page, not per scroll frame.
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
