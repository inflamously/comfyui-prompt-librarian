/* ==========================================================================
   Prompt Librarian — duplicate-threshold picker
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { cls, h } from "../shared/dom.js";
import { CHECK, bindKeys, isFn, toast } from "./common.js";
import { openPopover } from "./popover.js";

export const THRESHOLDS = [0.8, 0.85, 0.9, 0.95, 0.99];

/**
 * 80/85/90/95/99 %. Calls `onPick(value)` immediately (the panel must react
 * without waiting for the network) and persists through `POST /settings`.
 *
 * @param {object} ctx
 * @param {{anchor: HTMLElement, value?: number, onPick: (v: number) => void}} opts
 */
export function openThresholdPicker(ctx, { anchor, value, onPick } = {}) {
  let cur = Number(value);
  if (!Number.isFinite(cur) || cur <= 0) cur = 0.9;
  if (cur > 1) cur = cur / 100; // tolerate a percent-shaped value

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Duplicate threshold",
    className: "pl-pick-thresh",
    render: (el, handle) => {
      const list = h("div", { role: "listbox", "aria-label": "Duplicate threshold" });
      el.appendChild(list);
      const rows = [];
      let active = Math.max(0, THRESHOLDS.indexOf(cur));

      const paint = () => {
        for (let i = 0; i < rows.length; i++) cls(rows[i], "is-active", i === active);
      };

      const pick = (t) => {
        handle.close();
        if (isFn(onPick)) onPick(t);
        // Fire and forget: a settings write failure must not undo the choice
        // the user just made in the panel.
        if (ctx && ctx.API && isFn(ctx.API.settings)) {
          Promise.resolve()
            .then(() => ctx.API.settings({ dupe_threshold: t }))
            .catch(() => toast(ctx, "threshold not saved (using it for this session)", "warn"));
        }
      };

      for (const t of THRESHOLDS) {
        const isCur = Math.abs(t - cur) < 1e-9;
        const btn = h(
          "button",
          {
            className: "pl-opt",
            type: "button",
            role: "option",
            "aria-selected": isCur ? "true" : "false",
            onclick: () => pick(t),
          },
          h("span", { "aria-hidden": "true", style: { width: "1em", flex: "0 0 auto" } }, isCur ? CHECK : " "),
          h("span", { style: { flex: "1 1 auto" } }, `${Math.round(t * 100)}%`)
        );
        rows.push(btn);
        list.appendChild(btn);
      }
      paint();

      bindKeys(ctx, el, (e) => {
        if (!e || !rows.length) return;
        if (e.key === "ArrowDown") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.min(rows.length - 1, active + 1);
          paint();
        } else if (e.key === "ArrowUp") {
          if (isFn(e.preventDefault)) e.preventDefault();
          active = Math.max(0, active - 1);
          paint();
        } else if (e.key === "Enter") {
          if (isFn(e.preventDefault)) e.preventDefault();
          if (rows[active]) rows[active].click();
        }
      });
      return null;
    },
  });
  return pop;
}
