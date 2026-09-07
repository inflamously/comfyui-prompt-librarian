/* Filter selection stores the query, not all matching IDs; bulk endpoints
 * resolve it server-side so selection can span unloaded pages.
 */

import { fmtInt } from "../shared/format.js";
import { labelOf } from "../shared/text.js";

/**
 * @param {{ctx: object, source: object, onChange?: () => void}} deps
 */
export function createSelection({ ctx, source, onChange }) {
  const st = () => ctx.getState();
  const changed = () => {
    if (typeof onChange === "function") onChange();
  };

  function toggleIds(ids, on) {
    const state = st();
    const sel = state.selection;
    if (state.selectionMode === "filter") {
      ctx.setState({ selectionMode: "ids" }, { silent: true });
      sel.clear();
    }
    for (const id of ids) {
      if (on) sel.add(id);
      else sel.delete(id);
    }
    ctx.setState({ selection: sel, selectionMode: "ids" });
    changed();
  }

  function toggleId(id, on) {
    toggleIds([id], on);
  }

  /** A collapsed cluster selects all members; an expanded member selects only itself.
   */
  function toggleRow(index, on) {
    const ids = typeof source.idsAt === "function"
      ? source.idsAt(index)
      : [String((source.peek(index) || {}).id || "")].filter(Boolean);
    if (ids.length) toggleIds(ids, on);
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
    changed();
  }

  function clear() {
    const sel = st().selection;
    sel.clear();
    ctx.setState({ selection: sel, selectionMode: "ids" });
    changed();
  }

  function selectAllFiltered() {
    const sel = st().selection;
    sel.clear();
    ctx.setState({ selection: sel, selectionMode: "filter" });
    changed();
  }

  function queryForServer() {
    const q = st().query;
    return {
      q: q.q || "",
      tags: q.tags || [],
      dupes_only: !!q.dupesOnly,
    };
  }

  function current() {
    const state = st();
    if (state.selectionMode === "filter") return { query: queryForServer() };
    return { ids: Array.from(state.selection) };
  }

  function count() {
    const state = st();
    if (state.selectionMode !== "filter") return state.selection.size;
    // Bulk queries resolve records, so report recordTotal rather than folded rows.
    return source.recordTotal == null ? source.total : source.recordTotal;
  }

  /** Confirmation labels come from loaded pages only.
   */
  function labels(limit = 5) {
    const state = st();
    const out = [];
    const all = state.selectionMode === "filter";
    const wanted = all ? null : new Set(state.selection);
    for (let i = 0; i < source.total && out.length < limit; i++) {
      const rec = source.peek(i);
      if (!rec) continue;
      if (wanted && !wanted.has(String(rec.id))) continue;
      const label = labelOf(rec);
      if (label || !all) out.push(label || String(rec.id));
    }
    return out;
  }

  function describe() {
    const n = count();
    const list = labels(5);
    const more = n > list.length ? `\n… and ${fmtInt(n - list.length)} more` : "";
    return `${fmtInt(n)} prompt${n === 1 ? "" : "s"}:\n${list.map((s) => `  ${s}`).join("\n")}${more}`;
  }

  return {
    toggleId,
    toggleIds,
    toggleRow,
    selectRange,
    clear,
    selectAllFiltered,
    queryForServer,
    current,
    count,
    labels,
    describe,
    mode: () => st().selectionMode,
  };
}
