/* ==========================================================================
   Prompt Librarian — the footer / bulk bar
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Shares the rail's fifth grid row with the idle footer line, so `.pl-rail`
   keeps exactly five children — see the note in browse/index.js.
   ========================================================================== */

import { clear, h } from "../shared/dom.js";
import { fmtInt } from "../shared/format.js";
import { pickOne } from "./picker.js";

const MIDDOT = String.fromCharCode(0x00b7); // "·"

/**
 * @param {{ctx: object, el: HTMLElement, source: object, selection: object}} deps
 * @returns {{paint: () => void}}
 */
export function createBulkBar({ ctx, el, source, selection }) {
  const st = () => ctx.getState();

  function paint() {
    clear(el);
    const n = selection.count();
    if (!n) {
      // The spec's footer line. Same row as the bulk bar so `.pl-rail` keeps
      // exactly five children.
      el.appendChild(h("span", null, `scroll ${MIDDOT} virtualised list`));
      return;
    }
    const mode = st().selectionMode;
    el.appendChild(
      h("span", null, `${fmtInt(n)} selected${mode === "filter" ? " (all filtered)" : ""}`)
    );
    if (mode !== "filter" && source.total > n) {
      el.appendChild(
        h(
          "button",
          {
            className: "pl-btn pl-btn-ghost pl-btn-sm",
            type: "button",
            onclick: () => selection.selectAllFiltered(),
          },
          "select all filtered"
        )
      );
    }
    el.appendChild(
      h(
        "button",
        { className: "pl-btn pl-btn-ghost pl-btn-sm", type: "button", onclick: () => selection.clear() },
        "clear"
      )
    );
    el.appendChild(h("span", { className: "pl-spacer" }));
    el.appendChild(
      h(
        "button",
        {
          className: "pl-btn pl-btn-sm",
          type: "button",
          // currentTarget is read synchronously — it is null by the time the
          // async retag resumes.
          onclick: (ev) => retag(ev.currentTarget),
        },
        "retag"
      )
    );
    el.appendChild(
      h("button", { className: "pl-btn pl-btn-sm pl-btn-danger", type: "button", onclick: remove }, "delete")
    );
  }

  async function afterBulk(msg) {
    ctx.invalidateMeta();
    selection.clear();
    await ctx.refreshAll();
    if (msg) ctx.toast(msg, { kind: "success" });
  }

  async function remove() {
    const n = selection.count();
    if (!n) return;
    const ok = await ctx.confirmDialog({
      title: `Delete ${fmtInt(n)} prompt${n === 1 ? "" : "s"}?`,
      message: `This cannot be undone.\n\n${selection.describe()}`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.API.bulkDelete(selection.current());
      await afterBulk(`deleted ${fmtInt(n)} prompt${n === 1 ? "" : "s"}`);
    } catch (err) {
      ctx.reportError(err, "bulk delete");
    }
  }

  async function retag(anchor) {
    const n = selection.count();
    if (!n) return;
    const tag = await pickOne(
      ctx,
      "Add tag",
      st().tags.map((t) => t.name),
      { allowNew: true, anchor }
    );
    if (!tag) return;
    try {
      await ctx.API.bulkRetag(selection.current(), [tag], []);
      await afterBulk(`tagged ${fmtInt(n)} with ${tag}`);
    } catch (err) {
      ctx.reportError(err, "bulk retag");
    }
  }

  return { paint };
}
