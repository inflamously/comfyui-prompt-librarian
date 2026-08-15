/* ==========================================================================
   Prompt Librarian — the shared helper barrel
   --------------------------------------------------------------------------
   INERT ON IMPORT. Re-exports only.

   `modal/ctx.js` hands this whole namespace to the panes as `ctx.dom`, so the
   inspector can reach every helper without knowing the path back to this
   directory. Consumers that only want one group (`shared/text.js`,
   `shared/timing.js`, …) should import that file directly — the barrel exists
   for the namespace import, not as the preferred door.
   ========================================================================== */

export { NS } from "./ns.js";
export { singleton, singletonBag, warnOnce } from "./singleton.js";
export { NO_AUTOFILL, append, clear, cls, h } from "./dom.js";
export { CSS_LINK_ID, ensureStyles } from "./styles.js";
export { debounce, rafThrottle } from "./timing.js";
export { setComboValues } from "./widgets.js";
export {
  STAR_EMPTY,
  STAR_FULL,
  charCount,
  estimateTokens,
  firstLine,
  graphemes,
  stars,
  truncate,
} from "./text.js";
export { THIN_SPACE, escapeQuery, fmtInt, relTime } from "./format.js";
