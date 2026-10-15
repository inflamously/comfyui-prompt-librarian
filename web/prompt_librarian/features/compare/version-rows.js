/* The rows of the version list: building them from the /versions previews
 * (pure), and the DOM for one row. Row 0 is the current body; the rest are
 * snapshots, newest first.
 */

import { cls, h } from "../../shared/dom.js";
import { fmtInt, relTime } from "../../shared/format.js";
import { labelOf, truncate } from "../../shared/text.js";
import { MIDDOT, str } from "./text.js";

/** [current, newest, …, oldest] from the record and its version previews. */
export function buildRows(record, currentBody, previews) {
  const rows = [{
    index: null,
    isCurrent: true,
    label: labelOf(record) || "current",
    preview: truncate(str(currentBody).replace(/\s+/g, " ").trim(), 160),
    chars: str(currentBody).length,
    ts: str(record.updated),
    src: null,
  }];
  const sorted = (previews || []).slice().sort((x, y) => (Number(y.index) || 0) - (Number(x.index) || 0));
  for (const v of sorted) {
    rows.push({
      index: Number(v.index),
      isCurrent: false,
      // Historical labels are derived from the current corpus.
      label: str(v.label) || `version ${Number(v.index) + 1}`,
      preview: str(v.preview),
      chars: Number(v.chars) || 0,
      ts: str(v.ts),
      src: v.src || null,
    });
  }
  for (const row of rows) row.meta = rowMeta(row);
  return rows;
}

/** "3 days ago · 412 chars · from a merge" */
export function rowMeta(row) {
  const bits = [];
  const rel = relTime(row.ts);
  if (rel) bits.push(rel);
  bits.push(`${fmtInt(row.chars)} chars`);
  if (row.src) bits.push("from a merge");
  return bits.join(` ${MIDDOT} `);
}

/** An empty row; paintVersionRow fills it (the virtual list recycles them). */
export function createVersionRow() {
  const label = h("span", { className: "pl-row-name" });
  const badge = h("span", { className: "pl-badge-dupe", hidden: true }, "current");
  const preview = h("div", { className: "pl-row-body" });
  const meta = h("div", { className: "pl-row-meta" });
  const row = h("div", { className: "pl-row", role: "option", "aria-selected": "false" },
    h("span", { className: "pl-row-bar" }), label, badge, preview, meta);
  row.__parts = { label, badge, preview, meta };
  return row;
}

/** Paint `item` into `row`; null paints a skeleton. */
export function paintVersionRow(row, item, index, selected) {
  const p = row.__parts;
  if (!item) {
    row.classList.add("pl-row-skel");
    p.label.textContent = p.preview.textContent = p.meta.textContent = "";
    p.badge.hidden = true;
    return;
  }
  row.classList.remove("pl-row-skel");
  p.label.textContent = item.label;
  p.badge.hidden = !item.isCurrent;
  p.preview.textContent = item.preview;
  p.meta.textContent = item.meta;
  row.setAttribute("aria-selected", String(index === selected));
  cls(row, "is-sel", index === selected);
  row.dataset.idx = String(index);
}
