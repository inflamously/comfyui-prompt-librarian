/* ==========================================================================
   Prompt Librarian — list selection
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   TWO SELECTION MODES:
     "ids"    an explicit Set of record ids
     "filter" the abstract "everything the current query matches" — the QUERY
              is stored, not 1 284 ids, which is the only shape that scales and
              exactly what the bulk endpoints accept as `{query}`.
   ========================================================================== */

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
    changed();
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

  /** The `{ids}` or `{query}` selector the bulk endpoints take. */
  function current() {
    const state = st();
    if (state.selectionMode === "filter") return { query: queryForServer() };
    return { ids: Array.from(state.selection) };
  }

  function count() {
    const state = st();
    return state.selectionMode === "filter" ? source.total : state.selection.size;
  }

  /** First five labels, for the confirm text. Loaded pages only, by design. */
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
