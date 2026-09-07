import { CHECK, PLUS, bindKeys, isFn, toast } from "./common.js";
import { buildMenu, matches, taxonomyRows } from "./menu.js";
import { openPopover } from "./popover.js";

const MAX_TAG_CHARS = 40; // prompt_librarian/store/types.py MAX_TAG_CHARS

/** Mirror backend whitespace and length rules. JavaScript lowercasing only
 * approximates Python casefold; it does not cover every Unicode expansion.
 *
 * @param {string} tag
 * @returns {string}
 */
export function normalizeTag(tag) {
  const text = String(tag == null ? "" : tag)
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
  return text.slice(0, MAX_TAG_CHARS);
}

/**
 * @param {object} ctx
 * @param {{anchor: HTMLElement, placement?: string, selected?: string[], value?: string[],
 *          onPick: (tag: string) => void, onRemove?: (tag: string) => void}} opts
 */
export function openTagPicker(
  ctx,
  { anchor, placement, selected, value, onPick, onRemove } = {}
) {
  const state = ctx && isFn(ctx.getState) ? ctx.getState() : {};
  const all = taxonomyRows(state && state.tags);
  // inspector/ passes `value`; the frozen contract says `selected`. Both.
  const initial = Array.isArray(selected) ? selected : Array.isArray(value) ? value : [];
  const chosen = new Set(initial.map(normalizeTag).filter(Boolean));
  let menu = null;

  const pop = openPopover({
    anchor,
    placement,
    ctx,
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

      // Keep multi-select open until Escape or an outside click.
      function toggle(tag) {
        const t = normalizeTag(tag);
        if (!t) return;
        if (chosen.has(t)) {
          // Without onRemove, unchecking cannot update the record; keep it selected.
          if (!isFn(onRemove)) return;
          chosen.delete(t);
          onRemove(t);
        } else {
          if (chosen.size >= 32) {
            toast(ctx, "32 tags is the limit", "error");
            return;
          }
          chosen.add(t);
          if (isFn(onPick)) onPick(t);
        }
        rebuild({ preserveScroll: true });
        handle.reposition();
      }

      function rebuild({ preserveScroll = false } = {}) {
        // Preserve scrollTop across option replacement, which temporarily collapses the list.
        const scrollTop = preserveScroll ? el.scrollTop : 0;
        const q = menu.query();
        // Filter raw and normalized text so Camera Move finds camera-move.
        const qn = normalizeTag(q);
        const items = all
          .filter((t) => matches(t.name, q) || (qn && matches(t.name, qn)))
          .map((t) => {
            const key = normalizeTag(t.name);
            return {
              label: t.name,
              meta: t.count ? String(t.count) : null,
              selected: chosen.has(key),
              mark: chosen.has(key) ? CHECK : " ",
              run: () => toggle(t.name),
            };
          });
        const typed = normalizeTag(menu.query());
        const known = all.some((t) => normalizeTag(t.name) === typed);
        if (typed && !known) {
          items.unshift({
            label: `${PLUS} "${typed}"`,
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

  if (pop && menu) bindKeys(ctx, pop.el, (e) => menu.onKey(e));
  return pop;
}
