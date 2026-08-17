/* ==========================================================================
   Prompt Librarian — the list row
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   textContent ONLY. Never innerHTML after creation: it is both the XSS
   defence for user-authored prompt bodies and the reason recycling is fast
   (assigning textContent on an existing node skips the HTML parser).
   ========================================================================== */

import { h } from "../shared/dom.js";
import { firstLine, labelOf } from "../shared/text.js";
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
      // Inside `.pl-row-name` (a flex box) rather than as a grid child: the
      // row's `grid-template-areas` is load-bearing for its height, and a
      // fourth column would have meant re-tuning every area.
      h("span", { className: "pl-row-twisty", hidden: true, "aria-hidden": "true" }),
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
    twisty: row.children[2].children[0],
    label: row.children[2].children[1],
    match: row.children[2].children[2],
    badge: row.children[3],
    body: row.children[4],
    meta: row.children[5],
  };
  return row;
}

const TWISTY_OPEN = String.fromCharCode(0x25be); // "▾"
const TWISTY_SHUT = String.fromCharCode(0x25b8); // "▸"

/**
 * Paint one row. `state` is the modal state — passed in rather than read from
 * a closure so this stays a pure function of (row, item, index, state, view).
 *
 * `view` is the GroupedView, and it is what decides whether this index is a
 * duplicate-cluster header, a member inside an opened one, or an ordinary row.
 * Omit it and every row paints flat, which is exactly what the compare dialog's
 * reuse of this renderer wants.
 */
export function updateRow(row, item, index, state, view) {
  const p = row.__parts;
  row.dataset.index = String(index);

  if (!item) {
    row.classList.add("pl-row-skel");
    row.classList.remove("is-member", "is-group");
    row.removeAttribute("data-id");
    row.setAttribute("aria-selected", "false");
    p.label.textContent = "";
    p.body.textContent = "";
    p.meta.textContent = "";
    p.match.hidden = true;
    p.badge.hidden = true;
    p.twisty.hidden = true;
    p.check.checked = false;
    return;
  }

  row.classList.remove("pl-row-skel");
  const id = String(item.id || "");
  row.dataset.id = id;
  row.id = "pl-r-" + id;

  // The backend's derived handle: the terms this body has that the rest of
  // the library does not. It is a *label*, not an identity — never key
  // anything off it, and never let a user believe they set it.
  p.label.textContent = labelOf(item) || "(empty prompt)";

  const pct = item.match_pct;
  if (typeof pct === "number" && pct > 0) {
    p.match.textContent = `${Math.round(pct)}% match`;
    p.match.visibility = false;
  } else {
    p.match.visibility = true;
    p.match.textContent = "";
  }

  // Three row kinds, and the badge says which: a cluster header counts the
  // whole cluster, a member inside an open one says nothing (its header just
  // did), an ordinary row keeps the near-dupe badge.
  const size = Number(item.group_size) || 1;
  const member = !!view && view.isMember(index);
  const header = !!view && !member && size > 1;
  const open = header && view.isOpen(id);

  row.classList.toggle("is-member", member);
  row.classList.toggle("is-group", header);

  p.twisty.hidden = !header;
  if (header) {
    p.twisty.textContent = open ? TWISTY_OPEN : TWISTY_SHUT;
    p.twisty.visibility = "shown"
    row.setAttribute("aria-expanded", open ? "true" : "false");
  } else {
    p.twisty.textContent = "";
    p.twisty.visibility = "hidden";
    row.removeAttribute("aria-expanded");
  }

  const dupes = Number(item.dupe_count) || 0;
  if (header) {
    p.badge.textContent = `${size} copies`;
    p.badge.hidden = false;
  } else if (!member && dupes > 0) {
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
