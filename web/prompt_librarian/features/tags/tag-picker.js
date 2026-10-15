/* The multi-select tag picker: a filterable list of the library's tags with a
 * "+ new" row for unknown text. It stays open while tags are toggled, until
 * Escape or an outside click, and keeps its scroll offset across rebuilds.
 */

import { onKey } from "../../shared/keys.js";
import { buildMenu, matches } from "../../shared/ui/menu.js";
import { openPopover } from "../../shared/ui/popover.js";
import { MAX_TAGS, normalizeTag, taxonomyRows } from "./normalize.js";

const CHECK = String.fromCharCode(0x2713); // ✓, from a code point so a wrong charset cannot mangle it

/**
 * Open the picker on `anchor` (an element, or a getter for one that re-renders).
 * `taxonomy` is the library's tag list; without `onRemove`, a chosen tag cannot
 * be unchecked; `allowNew: false` drops the "+ new tag" row.
 * @param {{anchor: HTMLElement|(() => HTMLElement), placement?: string, selected?: string[], allowNew?: boolean,
 *          taxonomy?: Array, layers?: object, toast?: (msg: string, opts: object) => void,
 *          onPick?: (tag: string) => void, onRemove?: (tag: string) => void}} deps
 * @returns {import("../../shared/ui/popover.js").Popover|null}
 */
export function openTagPicker({
  anchor, placement, selected = [], allowNew = true, taxonomy, layers, toast, onPick, onRemove,
} = {}) {
  const all = taxonomyRows(taxonomy);
  const chosen = new Set(selected.map(normalizeTag).filter(Boolean));
  let menu = null;

  const pop = openPopover({
    anchor,
    placement,
    layers,
    ariaLabel: "Tags",
    className: "pl-pick-tags",
    render: (el, handle) => {
      menu = buildMenu(el, {
        placeholder: "filter or add a tag…",
        ariaLabel: "Tags",
        emptyLabel: "no tags yet",
        onQuery: () => {
          rebuild();
          handle.reposition();
        },
      });

      function toggle(tag) {
        const t = normalizeTag(tag);
        if (!t) return;
        if (chosen.has(t)) {
          if (!onRemove) return;
          chosen.delete(t);
          onRemove(t);
        } else {
          if (chosen.size >= MAX_TAGS) {
            toast?.(`${MAX_TAGS} tags is the limit`, { kind: "error" });
            return;
          }
          chosen.add(t);
          onPick?.(t);
        }
        rebuild({ preserveScroll: true });
        handle.reposition();
        // The clicked option was just replaced, which drops focus to <body>, outside
        // the modal's key guard; without this, Escape and the arrows stop working.
        menu.input.focus({ preventScroll: true });
      }

      function rebuild({ preserveScroll = false } = {}) {
        // Replacing the options collapses the list for a moment, which resets scrollTop.
        const scrollTop = preserveScroll ? el.scrollTop : 0;
        const q = menu.query();
        const typed = normalizeTag(q); // so "Camera Move" finds camera-move
        const items = all
          .filter((t) => matches(t.name, q) || (typed && matches(t.name, typed)))
          .map((t) => {
            const on = chosen.has(normalizeTag(t.name));
            return {
              label: t.name,
              meta: t.count ? String(t.count) : null,
              selected: on,
              mark: on ? CHECK : " ",
              run: () => toggle(t.name),
            };
          });
        if (allowNew && typed && !all.some((t) => normalizeTag(t.name) === typed)) {
          items.unshift({
            label: `+ "${typed}"`,
            className: "pl-opt-new",
            mark: chosen.has(typed) ? CHECK : " ",
            run: () => toggle(typed),
          });
        }
        menu.setItems(items);
        if (preserveScroll) el.scrollTop = scrollTop;
      }

      rebuild();
      return null;
    },
  });

  if (pop?.isOpen() && menu) pop.own(onKey(pop.el, "keydown", (e) => menu.onKey(e)));
  return pop;
}
