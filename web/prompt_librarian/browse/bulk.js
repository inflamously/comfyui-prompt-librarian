/* Share the footer grid row so .pl-rail keeps its five-child CSS layout.
 */

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
      el.appendChild(h("span", null, `scroll ${MIDDOT} virtualised list`));
      return;
    }
    const mode = st().selectionMode;
    el.appendChild(
      h("span", null, `${fmtInt(n)} selected${mode === "filter" ? " (all filtered)" : ""}`)
    );
    // Compare selected records with recordTotal, not the number of folded rows.
    const reachable = source.recordTotal == null ? source.total : source.recordTotal;
    if (mode !== "filter" && reachable > n) {
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
