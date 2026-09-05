import { NS } from "../shared/ns.js";
import { h } from "../shared/dom.js";
import { firstLine } from "../shared/text.js";
import { MIDDOT, bindKeys, isFn } from "./common.js";
import { insertAtCaret } from "./caret.js";
import { buildMenu, matches } from "./menu.js";
import { openPopover } from "./popover.js";

/** Insert the body normally; Shift inserts a [[name]] reference for runtime expansion.
 *
 * @param {object} ctx
 * @param {{anchor: HTMLElement, textarea: HTMLTextAreaElement,
 *          onInsert?: (text: string) => void}} opts
 */
export function openSnippets(ctx, { anchor, textarea, onInsert } = {}) {
  let menu = null;
  let entries = [];
  let loaded = false;

  const insert = (text) => {
    // Prefer onInsert because it also updates the inspector buffer and dirty state.
    if (isFn(onInsert)) onInsert(text);
    else insertAtCaret(textarea, text);
  };

  const pop = openPopover({
    anchor,
    ctx,
    ariaLabel: "Insert snippet",
    className: "pl-pick-snip",
    render: (el, handle) => {
      menu = buildMenu(el, {
        placeholder: "filter snippets…",
        ariaLabel: "Insert snippet",
        emptyLabel: "loading…",
        onQuery: () => {
          rebuild();
          handle.reposition();
        },
      });
      el.appendChild(
        h(
          "div",
          {
            className: "pl-lbl",
            style: { padding: "6px 9px 2px" },
          },
          `enter inserts the text ${MIDDOT} shift+enter inserts [[name]]`
        )
      );

      function rebuild() {
        const q = menu.query();
        const items = entries
          .filter((e) => matches(e.name, q) || matches(e.body, q))
          .map((e) => ({
            label: e.name,
            meta: firstLine(e.body, 28),
            run: (ev) => {
              handle.close();
              insert(ev && ev.shiftKey ? `[[${e.name}]]` : e.body);
            },
          }));
        menu.setItems(items);
        if (loaded && !entries.length) {
          menu.setItems([{ label: "no snippets saved yet", disabled: true }]);
        }
      }

      menu.setItems([{ label: "loading…", disabled: true }]);

      const load = ctx && ctx.API && isFn(ctx.API.snippets) ? ctx.API.snippets() : Promise.resolve(null);
      Promise.resolve(load)
        .then((data) => {
          loaded = true;
          const bag = (data && data.snippets) || {};
          entries = Object.keys(bag)
            .sort()
            .map((name) => {
              const v = bag[name];
              const body = v && typeof v === "object" ? String(v.body == null ? "" : v.body) : String(v == null ? "" : v);
              return { name: String(name), body };
            });
          if (!handle.isOpen()) return;
          rebuild();
          handle.reposition();
        })
        .catch((err) => {
          loaded = true;
          if (!handle.isOpen()) return;
          menu.setItems([{ label: "could not load snippets", disabled: true }]);
          console.error(`${NS} snippets failed`, err);
        });

      bindKeys(ctx, el, (e) => menu.onKey(e));
      return null;
    },
  });

  return pop;
}
