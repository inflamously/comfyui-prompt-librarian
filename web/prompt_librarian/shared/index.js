/* modal/context.js exposes this namespace as ctx.dom. Import leaf modules when
 * only individual helpers are needed.
 */

export { NS } from "./ns.js";
export { singleton, singletonBag, warnOnce } from "./singleton.js";
export { NO_AUTOFILL, append, clear, cls, h } from "./dom.js";
export { CSS_LINK_ID, ensureStyles } from "./styles.js";
export { debounce, rafThrottle } from "./timing.js";
export { setComboValues } from "./widgets.js";
export {
  LABEL_CHARS,
  STAR_EMPTY,
  STAR_FULL,
  charCount,
  estimateTokens,
  firstLine,
  graphemes,
  headLabel,
  labelOf,
  stars,
  truncate,
} from "./text.js";
export { THIN_SPACE, escapeQuery, fmtInt, relTime } from "./format.js";
