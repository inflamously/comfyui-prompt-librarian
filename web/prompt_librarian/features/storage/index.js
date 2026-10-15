/* Public surface of the storage feature. */

import { storageActions } from "./actions.js";
import { StorageButton, StorageHint } from "./controls.js";
import { StorageDialog } from "./storage-dialog.js";

/**
 * deps: api, slice (storage), caps() -> capability flags, layers() ->
 * LayerStack, choose(opts), toast, reportError(err, what), onLibraryChanged(),
 * isOpen(), and session() -> a token that changes when the modal reopens.
 */
export function createStorage(deps) {
  const actions = storageActions(deps);

  /** Fetch the status, then open the dialog unless the modal closed meanwhile. */
  async function open() {
    const session = deps.session();
    const current = () => deps.isOpen() && deps.session() === session;
    try { await actions.reload(); }
    catch (err) { if (current()) deps.reportError(err, "storage status"); }
    if (!current()) return null;
    const stack = deps.layers();
    let layer = null;
    const dialog = new StorageDialog({ slice: deps.slice, actions, close: () => stack.pop(layer) });
    layer = stack.push({ component: dialog, closeOnOutside: false });
    return dialog;
  }

  return {
    ...actions,
    open,
    /** The header link and the footer hint; repaint them when caps change. */
    button: () => new StorageButton({ slice: deps.slice, caps: deps.caps, onOpen: open }),
    hint: () => new StorageHint({ slice: deps.slice, caps: deps.caps, onOptimize: actions.optimize }),
  };
}
