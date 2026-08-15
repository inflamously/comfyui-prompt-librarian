/* ==========================================================================
   Prompt Librarian — the dialogs barrel
   --------------------------------------------------------------------------
   INERT ON IMPORT. Re-exports only.

     diff.js          renderDiff(), the split/unified diff primitive
     compare.js       openCompare(), the compare/merge dialog
     merge-editor.js  openMergeEditor(), the editable union
     versions.js      openVersions(), the two-pane history
     common.js        the layer/keys/clipboard plumbing all three share

   The inspector imports this barrel by name and probes for several aliases,
   so the `openDiff` / `compareDialog` / `versionsDialog` spellings are part of
   the contract, not decoration.
   ========================================================================== */

export { MAX_TOKENS_PER_SIDE, reconstruct, renderDiff } from "./diff.js";
export { compareDialog, openCompare, openDiff } from "./compare.js";
export { openMergeEditor } from "./merge-editor.js";
export { RESTORE_CONFIRM, openVersions, openVersionsDialog, versionsDialog } from "./versions.js";
