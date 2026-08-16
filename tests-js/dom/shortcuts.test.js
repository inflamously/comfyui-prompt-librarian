/* ==========================================================================
   Ctrl/Cmd+S

   ComfyUI never sees this chord: the window-capture guard in modal/keys.js has
   already called stopImmediatePropagation() before shell.js is handed the
   event. The preventDefault() in shell.js is purely to suppress the BROWSER's
   "Save Page" dialog — which is why it is allowed here and forbidden on the
   guard itself, where preventDefault would break text entry.
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

describe("Ctrl+S", () => {
  test("Ctrl+S and Cmd+S both request a save, as an update", async () => {
    for (const meta of [false, true]) {
      env.reset();
      const { ctx, calls } = recorder();
      const s = await openShell(ctx);

      s.save({ meta });
      await flush();

      assert.deepEqual(calls, [false], meta ? "Cmd+S" : "Ctrl+S");
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

    assert.deepEqual(calls, [false], "e.repeat must be ignored");
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
    assert.deepEqual(calls, [false], "and it works again once the layer closes");
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
