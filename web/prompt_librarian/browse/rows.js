/* ==========================================================================
   Prompt Librarian — the list row
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   textContent ONLY. Never innerHTML after creation: it is both the XSS
   defence for user-authored prompt bodies and the reason recycling is fast
   (assigning textContent on an existing node skips the HTML parser).
   ========================================================================== */

import { h } from "../shared/dom.js";
import { firstLine } from "../shared/text.js";
import { fmtInt, relTime } from "../shared/format.js";

const MULT = String.fromCharCode(0x00d7); // "×"
const MIDDOT = String.fromCharCode(0x00b7); // "·"

/** A blank row, with its parts cached on `row.__parts`. */
export function createRow() {
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
 * Paint one row. `state` is the modal state — passed in rather than read from
 * a closure so this stays a pure function of (row, item, index, state).
 */
export function updateRow(row, item, index, state) {
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

  const bits = [`used ${fmtInt(item.used || 0)}${MULT}`];
  const when = relTime(item.last_run || item.updated);
  if (when) bits.push(when);
  p.meta.textContent = bits.join(` ${MIDDOT} `);

  row.setAttribute("aria-selected", state.currentId && state.currentId === id ? "true" : "false");
  p.check.checked = state.selectionMode === "filter" || state.selection.has(id);
}

/* Kept for callers that only want the row markup (the compare dialog reuses
   the same shape). Exported so it cannot drift silently. */
export const ROW_CLASSES = Object.freeze({
  row: "pl-row",
  skeleton: "pl-row-skel",
  selectedBar: "pl-row-bar",
});
