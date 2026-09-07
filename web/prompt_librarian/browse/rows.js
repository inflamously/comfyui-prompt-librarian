/* Render user-authored bodies and tags through textContent, never innerHTML.
 */

import { h } from "../shared/dom.js";
import { firstLine, labelOf } from "../shared/text.js";
import { fmtInt, relTime } from "../shared/format.js";

const MULT = String.fromCharCode(0x00d7); // "×"
const MIDDOT = String.fromCharCode(0x00b7); // "·"

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
      // Keep the twisty inside the name cell to preserve the row grid and height.
      h("span", { className: "pl-row-twisty", hidden: true, "aria-hidden": "true" }),
      h("span", { className: "pl-row-nm" }),
      h("span", { className: "pl-row-match", hidden: true })
    ),
    h("div", { className: "pl-badge-dupe", hidden: true }),
    h("div", { className: "pl-row-body" }),
    h("div", { className: "pl-row-meta" })
  );
  // Cache parts: recycled rows update every scroll frame.
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

/** Use GroupedView to interpret flat row indices; they are not record indices.
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

  // Derived labels are display-only; key records by ID.
  p.label.textContent = labelOf(item) || "(empty prompt)";

  const pct = item.match_pct;
  if (typeof pct === "number" && pct > 0) {
    p.match.textContent = `${Math.round(pct)}% match`;
    p.match.visibility = false;
  } else {
    p.match.visibility = true;
    p.match.textContent = "";
  }

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

export const ROW_CLASSES = Object.freeze({
  row: "pl-row",
  skeleton: "pl-row-skel",
  selectedBar: "pl-row-bar",
});
