/* ==========================================================================
   The middle tier — modal chrome without the panes

   openModal() is the WRONG entry point when pane contents are not what is under
   test: it mounts browse/ and inspector/, fetches taxonomy, and pulls the whole
   transport in behind it. For the shell's own behaviour — closing, Ctrl+S, key
   isolation, layers — all that is needed is:

       buildShell(); wireShell(); installKeyGuards();

   and then a hand-rolled `it.ctx`. No network, no panes, no DOM fixtures.

   This is the tier the save-on-close work lives in, so it is the tier that
   covers it.
   ========================================================================== */

import { imp } from "./mount.js";

const M = "prompt_librarian/modal/";

/**
 * Build the shell and hand back the handles a test needs.
 *
 * @param {object} ctxPatch overrides merged onto the default fake ctx. The two
 *   hooks that matter are `isDirty()` and `requestSave(asNew)` — the duck-typed
 *   contract inspector/index.js registers and modal/close.js consumes.
 */
export async function openShell(ctxPatch = {}) {
  const shell = await imp(M + "shell.js");
  const state = await imp(M + "state.js");
  const keys = await imp(M + "keys.js");
  const close = await imp(M + "close.js");
  const layers = await imp(M + "layers.js");

  shell.buildShell();
  shell.wireShell();
  keys.installKeyGuards();

  const it = state.inst();
  it.ctx = {
    isDirty: () => false,
    requestSave: async () => "saved",
    debounces: [],
    ...ctxPatch,
  };
  // closeModal() no-ops unless the modal is actually open.
  it.open = true;
  state.setModalVisible(true);

  return {
    it,
    root: it.root,
    els: it.els,
    closeBtn: it.els.close,
    shell,
    state,
    layers,
    attemptClose: close.attemptClose,
    closeModal: close.closeModal,
    isDirty: close.isDirty,

    /** Dispatch a keydown on the modal root — through the real capture guard. */
    key(k, opts = {}) {
      return it.root.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }),
      );
    },

    /** Dispatch a keydown on any element (must be inside root for the guard). */
    keyOn(el, k, opts = {}) {
      return el.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }),
      );
    },

    /** Ctrl+S, or Cmd+S with {meta:true}. */
    save({ meta = false, ...opts } = {}) {
      return this.key("s", { ctrlKey: !meta, metaKey: meta, ...opts });
    },

    /**
     * A full backdrop click. BOTH pointerdown and pointerup must land on the
     * backdrop for shell.js to treat it as a dismiss.
     */
    backdropClick() {
      const b = it.els.backdrop;
      b.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      b.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    },

    /**
     * A drag that STARTS inside the card and is released over the backdrop.
     * Must not close — otherwise a drag-select in the list throws away the edit.
     */
    dragToBackdrop() {
      it.els.card.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      it.els.backdrop.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    },
  };
}

/** Let queued microtasks and one timer tick drain. */
export function flush(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A promise with resolve exposed, for holding a save in flight. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
