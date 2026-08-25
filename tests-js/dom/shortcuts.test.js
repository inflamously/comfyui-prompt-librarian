/* ==========================================================================
   Ctrl/Cmd+S

   While the Librarian is open, the window-capture guard consumes Save Page
   and shell.js saves the prompt. On close, the retained shell must stop
   matching ComfyUI's modal gate so its own Ctrl+S command works again.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { openShell, flush } from "../harness/modal.js";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

/** A ctx that records every requestSave call. */
function recorder(status = "saved") {
  const calls = [];
  return {
    calls,
    ctx: {
      isDirty: () => true,
      requestSave: async (asNew) => {
        calls.push(asNew);
        return status;
      },
    },
  };
}

const COMFY_MODAL = '[role="dialog"][aria-modal="true"]';

/**
 * The relevant behavior of ComfyUI's real keybindingService:
 *
 *   - one bubble listener on window
 *   - Ctrl/Cmd+S is the core Comfy.SaveWorkflow binding
 *   - any matching modal suppresses command execution
 *
 * Keeping this faithful matters: a generic document listener did not expose
 * the retained hidden `.pl-card` that caused the production regression.
 */
function comfyWorkflowShortcut() {
  const saves = [];
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== "s") return;
    if (document.querySelector(COMFY_MODAL)) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    saves.push(e);
  });
  return saves;
}

describe("Ctrl+S", () => {
  test("the focused Librarian owns the chord instead of ComfyUI", async () => {
    const workflowSaves = comfyWorkflowShortcut();
    const { ctx, calls } = recorder();
    const s = await openShell(ctx);
    const promptInput = document.createElement("textarea");
    s.els.inspect.appendChild(promptInput);
    promptInput.focus();
    const chord = new KeyboardEvent("keydown", {
      key: "s", ctrlKey: true, bubbles: true, cancelable: true,
    });

    promptInput.dispatchEvent(chord);
    await flush();

    assert.equal(document.activeElement, promptInput);
    assert.deepEqual(calls, [true], "the Librarian saves the prompt");
    assert.deepEqual(workflowSaves, [], "the modal chord must not also save the workflow");
    assert.equal(chord.defaultPrevented, true, "the modal chord cannot open Save Page");
    env.assertNoErrors();
  });

  test("ComfyUI's modal gate blocks its workflow command only while the Librarian is open", async () => {
    const workflowSaves = comfyWorkflowShortcut();
    const { ctx, calls } = recorder();
    const s = await openShell(ctx);
    const comfyInput = document.createElement("input");
    document.body.appendChild(comfyInput);
    comfyInput.focus();
    const chord = new KeyboardEvent("keydown", {
      key: "s", ctrlKey: true, bubbles: true, cancelable: true,
    });

    comfyInput.dispatchEvent(chord);
    await flush();

    assert.equal(document.activeElement, comfyInput);
    assert.equal(document.querySelector(COMFY_MODAL), s.els.card);
    assert.deepEqual(workflowSaves, [], "ComfyUI does not run global commands over a modal");
    assert.deepEqual(calls, [], "an unfocused Librarian must not save");
    assert.equal(chord.defaultPrevented, true, "ComfyUI still suppresses Save Page");
    env.assertNoErrors();
  });

  test("closing clears ComfyUI's modal gate and returns Ctrl+S to workflow save", async () => {
    const workflowSaves = comfyWorkflowShortcut();
    const comfyInput = document.createElement("input");
    document.body.appendChild(comfyInput);
    comfyInput.focus();
    const { ctx, calls } = recorder();
    const s = await openShell(ctx);
    s.it.previouslyFocused = comfyInput;

    s.closeModal();
    assert.equal(document.querySelector(COMFY_MODAL), null, "the hidden shell is not an open modal");
    const chord = new KeyboardEvent("keydown", {
      key: "s", ctrlKey: true, bubbles: true, cancelable: true,
    });
    comfyInput.dispatchEvent(chord);
    await flush();

    assert.equal(document.activeElement, comfyInput, "close restores ComfyUI focus");
    assert.deepEqual(workflowSaves, [chord], "ComfyUI executes workflow save once");
    assert.deepEqual(calls, [], "the closed Librarian must not save");
    assert.equal(chord.defaultPrevented, true, "the ComfyUI hook suppresses Save Page");
    env.assertNoErrors();
  });

  test("Ctrl+S and Cmd+S both request a save, as a create", async () => {
    for (const meta of [false, true]) {
      env.reset();
      const { ctx, calls } = recorder();
      const s = await openShell(ctx);

      s.save({ meta });
      await flush();

      assert.deepEqual(calls, [true], meta ? "Cmd+S" : "Ctrl+S");
      assert.equal(s.it.open, true, "saving must not close the modal");
      env.assertNoErrors();
    }
  });

  test("a held chord does not queue a save per repeat", async () => {
    const { ctx, calls } = recorder();
    const s = await openShell(ctx);

    s.save();
    s.save({ repeat: true });
    s.save({ repeat: true });
    await flush();

    assert.deepEqual(calls, [true], "e.repeat must be ignored");
    env.assertNoErrors();
  });

  test("the chord is only S with ctrl/meta — modifiers and other keys are ignored", async () => {
    const { ctx, calls } = recorder();
    const s = await openShell(ctx);

    s.save({ altKey: true });
    s.save({ shiftKey: true });
    s.key("s"); // no modifier at all
    s.key("a", { ctrlKey: true });
    await flush();

    assert.deepEqual(calls, [], "none of these are the save chord");
    env.assertNoErrors();
  });

  test("an open layer owns the chord", async () => {
    // The merge editor binds its own Ctrl+S, and the conflict / duplicate
    // dialogs must not be saved out from under the user.
    const { ctx, calls } = recorder();
    const s = await openShell(ctx);

    s.layers.pushLayer({ el: document.createElement("div") });
    s.save();
    await flush();
    assert.deepEqual(calls, [], "a layer is on screen; the chord is not ours");

    s.layers.popLayer();
    s.save();
    await flush();
    assert.deepEqual(calls, [true], "and it works again once the layer closes");
    env.assertNoErrors();
  });

  test("a missing inspector is a no-op, not a crash", async () => {
    const s = await openShell({ requestSave: undefined });
    s.save();
    await flush();
    assert.equal(s.it.open, true);
    env.assertNoErrors();
  });

  test("a rejecting save logs once and never becomes an unhandled rejection", async () => {
    env.expectError(/Ctrl\+S save failed/);
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const s = await openShell({
        isDirty: () => true,
        requestSave: async () => {
          throw new Error("boom");
        },
      });
      s.save();
      await flush(10);
      assert.equal(env.errors.length, 1);
      assert.deepEqual(unhandled, []);
      assert.equal(s.it.open, true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    env.assertNoErrors();
  });

  test("narrow mode brings the editor forward before saving", async () => {
    // Otherwise the toast — and focusBody() on an empty prompt — land on a pane
    // the user cannot see.
    const { ctx } = recorder();
    const s = await openShell(ctx);

    s.root.dataset.w = "narrow";
    s.els.body.dataset.pane = "browse";
    s.save();
    assert.equal(s.els.body.dataset.pane, "edit", "switched before the save ran");

    await flush();
    env.assertNoErrors();
  });

  test("wide mode leaves the pane alone", async () => {
    const { ctx } = recorder();
    const s = await openShell(ctx);

    s.root.dataset.w = "wide";
    s.els.body.dataset.pane = "browse";
    s.save();
    await flush();

    assert.equal(s.els.body.dataset.pane, "browse");
    env.assertNoErrors();
  });

  test("the browser's Save Page dialog is suppressed, but plain typing is not", async () => {
    const { ctx } = recorder();
    const s = await openShell(ctx);

    const chord = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    s.root.dispatchEvent(chord);
    assert.equal(chord.defaultPrevented, true, "Ctrl+S must preventDefault");

    const letter = new KeyboardEvent("keydown", {
      key: "s",
      bubbles: true,
      cancelable: true,
    });
    s.root.dispatchEvent(letter);
    assert.equal(letter.defaultPrevented, false, "a plain letter must reach the textarea");

    await flush();
    env.assertNoErrors();
  });
});
