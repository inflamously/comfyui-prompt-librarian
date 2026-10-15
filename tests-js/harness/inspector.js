/* ==========================================================================
   Mount the real InspectorPane (features/inspector) on recording stand-ins.

   Every dep the pane takes has an inert default here; a test overrides only
   what it is about. The slice is a real Store slice and the layer stack a real
   LayerStack, so state round-trips and dialogs behave as in the modal.
   ========================================================================== */

import { imp } from "./mount.js";
import { stubAttachAutocomplete, stubMountDupes } from "./inspector-stubs.js";

/** A request lane that runs at once and has nothing to cancel. */
export function immediateLane() {
  const lane = (run) => Promise.resolve(run(undefined));
  lane.cancel = () => {};
  return lane;
}

/**
 * @param {object} [over] any InspectorPane dep, plus `host` (default: a fresh div in <body>)
 * @returns {Promise<{pane, slice, layers, el}>}
 */
export async function mountInspector({ host, ...over } = {}) {
  const { InspectorPane } = await imp("prompt_librarian/features/inspector/index.js");
  const { Store } = await imp("prompt_librarian/shared/store.js");
  const { LayerStack } = await imp("prompt_librarian/shared/ui/layer-stack.js");

  const slice = new Store({
    inspector: { currentId: null, current: null, baseline: null, buffer: { tags: [], body: "" } },
  }).slice("inspector");
  const layerHost = document.createElement("div");
  document.body.append(layerHost);
  const layers = new LayerStack(layerHost);
  const el = host || document.createElement("div");
  if (!el.isConnected) document.body.append(el);

  const pane = new InspectorPane({
    api: {},
    slice,
    lane: immediateLane(),
    caps: () => ({}),
    layers: () => layers,
    toast: () => null,
    dialogs: { choose: async (o) => o.cancelValue, confirm: async () => true },
    drafts: { save() {}, load: () => null, clear() {} },
    tags: { openPicker() {} },
    mountDupes: stubMountDupes(),
    attachAutocomplete: stubAttachAutocomplete(),
    compare: { versions() {}, compare() {} },
    pushToNode: () => ({ ok: true }),
    onLibraryChanged() {},
    ...over,
  });
  pane.mount(el);
  return { pane, slice, layers, el };
}
