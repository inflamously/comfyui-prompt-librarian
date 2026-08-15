/* ==========================================================================
   Prompt Librarian — the pickers barrel
   --------------------------------------------------------------------------
   INERT ON IMPORT. Re-exports only.

   One primitive — openPopover() — serves four consumers: tags,
   threshold, snippets and wildcards. Plus insertAtCaret(), the wildcard
   tokenizer, and attachMirror() (syntax highlighting behind the textarea).

   Read pickers/common.js before touching anything key-related in here.
   ========================================================================== */

export { openPopover } from "./popover.js";
export { buildMenu, matches, taxonomyRows } from "./menu.js";
export { normalizeTag, openTagPicker } from "./tags.js";
export { THRESHOLDS, openThresholdPicker } from "./threshold.js";
export { openSnippets } from "./snippets.js";
export { openWildcards } from "./wildcards.js";
export { dispatchInput, insertAtCaret } from "./caret.js";
export { TOK_CLASS, tokenizeWildcards } from "./tokenize.js";
export { attachMirror } from "./mirror.js";
