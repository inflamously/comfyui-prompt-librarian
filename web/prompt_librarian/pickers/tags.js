/* ==========================================================================
   Prompt Librarian — tag picker (multi-select + free text)
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { CHECK, PLUS, bindKeys, isFn, toast } from "./common.js";
import { buildMenu, matches, taxonomyRows } from "./menu.js";
import { openPopover } from "./popover.js";

const MAX_TAG_CHARS = 40; // prompt_librarian/store/types.py MAX_TAG_CHARS

/**
 * Mirror of `prompt_librarian/store/utils.py clean_tag`:
 *
 *     text = _WS_RE.sub("-", _as_str(tag).strip()).casefold()
 *     return text[:MAX_TAG_CHARS]
 *
 * i.e. strip → every internal whitespace RUN becomes a single "-" → casefold →
 * cap at 40 chars, in that order. The order matters: casefolding after the
 * whitespace substitution is what makes "Camera  Move" and "camera move" land
 * on the same "camera-move".
 *
 * JS has no `casefold()`; `toLowerCase()` is the closest equivalent and agrees
 * with it on everything except a handful of full-case-folding pairs (German ß
 * folds to "ss", Cherokee, ﬁ ligatures). Those degrade to "the server stores a
 * slightly different string than the picker predicted" — the backend
 * re-normalizes every tag it receives, so a stored tag is never malformed;
 * at worst a ß-tag shows as unchecked until the record reloads.
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

      // Multi-select: the popover STAYS OPEN so several tags can be toggled in
      // one visit. Escape / outside click is the way out.
      function toggle(tag) {
        const t = normalizeTag(tag);
        if (!t) return;
        if (chosen.has(t)) {
          // Without an onRemove the caller has no way to drop the tag, so
          // un-checking it here would show a state the record does not have.
          // inspector/ removes tags from its own chips instead.
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
        // Replacing every option briefly collapses the list. Browsers clamp
        // the popover's scrollTop during that collapse, so a multi-selection
        // used to jump back to the first tag after every click.
        const scrollTop = preserveScroll ? el.scrollTop : 0;
        const q = menu.query();
        // Filter on the raw text OR its normalized form, so typing
        // "Camera Move" finds the stored "camera-move" instead of offering to
        // create a tag that already exists.
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
