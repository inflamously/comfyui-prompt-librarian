/* Public surface of the gallery feature. */

import { ArrangeDialog } from "./arrange-dialog.js";
import { GalleryDialog } from "./gallery-dialog.js";

/**
 * deps: api, layers() -> LayerStack, toast, reportError, confirm(opts),
 * onFind(text), base() -> the prompt being written, nodeId(), renderer,
 * viewImage(ref) -> Blob.
 */
export function createGallery(deps) {
  /** Push a dialog that dims the page and closes on an outside click. */
  function open(Dialog, opts) {
    const stack = deps.layers();
    let layer = null;
    const dialog = new Dialog({ ...deps, ...opts, close: () => stack.pop(layer) });
    layer = stack.push({ component: dialog, closeOnOutside: true, dim: true });
    return dialog;
  }
  const openArrange = (opts) => open(ArrangeDialog, opts);
  return {
    /** Open the word gallery. */
    open: () => open(GalleryDialog, { openArrange }),
    /** Arrange one word's pictures: {item, onChange}. */
    arrange: openArrange,
  };
}
