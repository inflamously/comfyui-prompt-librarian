/* Public surface of the compare feature: a service that opens the compare and
 * version-history dialogs on the layer stack. */

import { CompareDialog } from "./compare-dialog.js";
import { MergeEditor } from "./merge-editor.js";
import { VersionsDialog } from "./versions-dialog.js";

/**
 * deps: api, lanes ({diff, versions}), layers() -> LayerStack, confirm(opts),
 * toast(message, opts), loadIntoNode(record), onLibraryChanged(), isNarrow().
 */
export function createCompare(deps) {
  /** Push a dialog component; it closes itself through `close`. */
  function open(Dialog, opts) {
    const stack = deps.layers();
    let layer = null;
    const dialog = new Dialog({ ...deps, ...opts, close: () => stack.pop(layer) });
    layer = stack.push({ component: dialog, closeOnOutside: false });
    return dialog;
  }
  const openMergeEditor = (opts) => open(MergeEditor, opts);
  return {
    /** Compare two sides: {a_id?, a_text?, b_id?, b_text?, titleA?, titleB?}. */
    compare: (opts) => open(CompareDialog, { ...opts, lane: deps.lanes.diff, openMergeEditor }),
    /** A record's version history: {id, record?, onRestored?}. */
    versions: (opts) => open(VersionsDialog, { ...opts, lane: deps.lanes.versions }),
  };
}
