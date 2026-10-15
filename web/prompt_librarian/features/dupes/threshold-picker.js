/* The duplicate-threshold picker: five fixed similarity levels. It only picks;
 * the panel applies the value and persists it.
 */

import { cls, h } from "../../shared/dom.js";
import { onKey } from "../../shared/keys.js";
import { openPopover } from "../../shared/ui/popover.js";

export const THRESHOLDS = [0.8, 0.85, 0.9, 0.95, 0.99];

const CHECK = String.fromCharCode(0x2713); // ✓, from a code point so a wrong charset cannot mangle it

/**
 * Open on `anchor` with `value` checked; `onPick(t)` runs after it closes.
 * @param {{anchor: HTMLElement, value: number, layers?: object, onPick: (t: number) => void}} deps
 */
export function openThresholdPicker({ anchor, value, layers, onPick }) {
  let active = Math.max(0, THRESHOLDS.findIndex((t) => Math.abs(t - value) < 1e-9));
  const rows = [];
  const pop = openPopover({
    anchor,
    layers,
    ariaLabel: "Duplicate threshold",
    className: "pl-pick-thresh",
    render: (el, handle) => {
      const list = h("div", { role: "listbox", "aria-label": "Duplicate threshold" });
      for (const t of THRESHOLDS) {
        const on = Math.abs(t - value) < 1e-9;
        rows.push(h("button", {
          className: "pl-opt",
          type: "button",
          role: "option",
          "aria-selected": String(on),
          onclick: () => { handle.close(); onPick(t); },
        },
        h("span", { "aria-hidden": "true", style: { width: "1em", flex: "0 0 auto" } }, on ? CHECK : " "),
        h("span", { style: { flex: "1 1 auto" } }, `${Math.round(t * 100)}%`)));
      }
      list.append(...rows);
      el.append(list);
      paint();
    },
  });
  // Focus follows the active row: the key bus only reaches the popover when
  // focus is inside it.
  function paint() {
    rows.forEach((row, i) => cls(row, "is-active", i === active));
    if (rows[active]?.isConnected) rows[active].focus({ preventScroll: true });
  }
  if (pop?.isOpen()) {
    pop.own(onKey(pop.el, "keydown", (e) => {
      if (e.key === "ArrowDown") active = Math.min(rows.length - 1, active + 1);
      else if (e.key === "ArrowUp") active = Math.max(0, active - 1);
      else if (e.key === "Enter") rows[active].click();
      else return;
      e.preventDefault();
      if (pop.isOpen()) paint();
    }));
    paint();
  }
  return pop;
}
