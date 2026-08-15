/* ==========================================================================
   Prompt Librarian — the filter chip row
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   One chip per active tag, plus the `dupes only` toggle. Chips
   are INTENT clicks: they re-run the search immediately, with no debounce.
   ========================================================================== */

import { clear, h } from "../shared/dom.js";
import { pickOne } from "./picker.js";

const TIMES = String.fromCharCode(0x00d7); // "×"

/**
 * @param {{ctx: object, el: HTMLElement, setQuery: (patch: object) => any}} deps
 * @returns {{paint: () => void}}
 */
export function createChips({ ctx, el, setQuery }) {
  const st = () => ctx.getState();

  function paint() {
    clear(el);
    const q = st().query;

    for (const tag of q.tags) {
      el.appendChild(
        h(
          "span",
          { className: "pl-chip is-on" },
          h("span", null, tag),
          h(
            "button",
            {
              className: "pl-chip-x",
              type: "button",
              "aria-label": `Clear tag ${tag}`,
              onclick: () => setQuery({ tags: q.tags.filter((t) => t !== tag) }),
            },
            TIMES
          )
        )
      );
    }
    el.appendChild(
      h(
        "button",
        {
          className: "pl-chip pl-chip-add",
          type: "button",
          // currentTarget is read synchronously — it is null by the time the
          // async pickTag resumes.
          onclick: (ev) => pickTag(ev.currentTarget),
        },
        h("span", null, "+ tag")
      )
    );
    el.appendChild(
      h(
        "button",
        {
          className: "pl-chip pl-chip-toggle" + (q.dupesOnly ? " is-on" : ""),
          type: "button",
          "aria-pressed": q.dupesOnly ? "true" : "false",
          onclick: () => setQuery({ dupesOnly: !st().query.dupesOnly }),
        },
        h("span", null, "dupes only")
      )
    );
  }

  async function pickTag(anchor) {
    const name = await pickOne(
      ctx,
      "Filter by tag",
      st().tags.map((t) => t.name),
      { anchor }
    );
    if (!name) return;
    const tags = st().query.tags.slice();
    if (!tags.includes(name)) tags.push(name);
    setQuery({ tags });
  }

  return { paint };
}
