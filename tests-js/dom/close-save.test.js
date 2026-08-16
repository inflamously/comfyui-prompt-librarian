/* ==========================================================================
   Save-on-close

   There used to be a `Discard unsaved edits?` bar here that refused to close,
   so a dirty buffer meant the modal could not be dismissed at all. Now a dirty
   buffer is saved first, and the decision of whether it is safe to close is
   carried by the five-value status vocabulary defined in inspector/save.js:

       "saved"   committed; safe to close
       "clean"   nothing to write; safe to close
       "blocked" a conflict/duplicate dialog is on screen — MUST STAY OPEN
       "failed"  the write errored — MUST STAY OPEN
       "busy"    a save is already in flight — MUST STAY OPEN

   modal/ compares that as a plain string and never imports the constant,
   because inspector/ is lazily loaded and may legitimately be absent. These
   tests pin both halves of that contract.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { openShell, flush, deferred } from "../harness/modal.js";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

/** Shorthand: a ctx whose save always reports `status`, counting calls. */
function saving(status) {
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

describe("attemptClose", () => {
  test("a clean buffer closes immediately and never calls requestSave", async () => {
    const calls = [];
    const s = await openShell({
      isDirty: () => false,
      requestSave: async (a) => {
        calls.push(a);
        return "saved";
      },
    });

    assert.equal(s.attemptClose(), true, "a clean close is synchronous");
    assert.equal(s.it.open, false);
    assert.equal(s.root.hidden, true);
    assert.deepEqual(calls, [], "nothing to save, so nothing was saved");
    assert.equal(s.it.closing, false);
    env.assertNoErrors();
  });

  for (const status of ["saved", "clean"]) {
    test(`a dirty buffer that reports "${status}" closes`, async () => {
      const { ctx, calls } = saving(status);
      const s = await openShell(ctx);

      assert.equal(s.attemptClose(), false, "a dirty close is asynchronous");
      await flush();

      assert.deepEqual(calls, [false], "saves as an update, never as new");
      assert.equal(s.it.open, false, `"${status}" must close`);
      assert.equal(s.it.closing, false, "the re-entry latch is released");
      env.assertNoErrors();
    });
  }

  for (const status of ["blocked", "failed", "busy"]) {
    test(`a dirty buffer that reports "${status}" stays open`, async () => {
      const { ctx, calls } = saving(status);
      const s = await openShell(ctx);

      s.attemptClose();
      await flush();

      assert.deepEqual(calls, [false]);
      assert.equal(s.it.open, true, `"${status}" must NOT close the modal`);
      assert.equal(s.root.hidden, false);
      assert.equal(s.it.closing, false, "the latch is released so a retry is possible");
      assert.equal(s.closeBtn.disabled, false, "the close button is usable again");
      env.assertNoErrors();
    });
  }

  test("an unknown status is treated as unsafe and keeps the modal open", async () => {
    // The vocabulary is duplicated as a comment across two modules; a typo on
    // either side must fail closed, not throw the buffer away.
    const { ctx } = saving("saevd");
    const s = await openShell(ctx);
    s.attemptClose();
    await flush();
    assert.equal(s.it.open, true);
    env.assertNoErrors();
  });

  test("dirty with NO save hook closes anyway", async () => {
    // Deliberate: an undismissable modal is a worse failure than a lost buffer,
    // and the sessionStorage draft still holds the text.
    const s = await openShell({ isDirty: () => true, requestSave: undefined });

    assert.equal(s.attemptClose(), true);
    assert.equal(s.it.open, false);
    env.assertNoErrors();
  });

  test("a rejecting requestSave keeps the modal open and logs exactly once", async () => {
    env.expectError(/save on close failed/);
    const s = await openShell({
      isDirty: () => true,
      requestSave: async () => {
        throw new Error("boom");
      },
    });

    s.attemptClose();
    await flush();

    assert.equal(s.it.open, true, "a failed save must not discard the buffer");
    assert.equal(s.it.closing, false);
    assert.equal(s.closeBtn.disabled, false);
    assert.equal(env.errors.length, 1, "logged once, not once per close path");
    env.assertNoErrors();
  });

  test("a throwing isDirty is treated as clean rather than trapping the user", async () => {
    env.expectError(/isDirty threw/);
    const s = await openShell({
      isDirty: () => {
        throw new Error("pane exploded");
      },
    });

    assert.equal(s.attemptClose(), true);
    assert.equal(s.it.open, false);
  });

  test("Esc-mashing does not stack saves", async () => {
    // The it.closing latch. Without it, five Escapes queue five saves and the
    // last one wins whatever the first four decided.
    const d = deferred();
    const calls = [];
    const s = await openShell({
      isDirty: () => true,
      requestSave: async (a) => {
        calls.push(a);
        return d.promise;
      },
    });

    const results = [
      s.attemptClose(),
      s.attemptClose(),
      s.attemptClose(),
      s.attemptClose(),
      s.attemptClose(),
    ];
    await flush();

    assert.deepEqual(calls, [false], "exactly one save in flight");
    assert.deepEqual(results, [false, false, false, false, false]);
    assert.equal(s.it.closing, true, "still latched while the save is in flight");

    d.resolve("saved");
    await flush();
    assert.equal(s.it.open, false, "closes once, after the save lands");
    assert.equal(s.it.closing, false);
    env.assertNoErrors();
  });

  test("the close button is disabled for the whole round trip", async () => {
    // The save runs a staleness GET and a duplicate POST before it can commit;
    // without this the button reads as broken for the length of a round trip.
    const d = deferred();
    const s = await openShell({
      isDirty: () => true,
      requestSave: () => d.promise,
    });

    assert.equal(s.closeBtn.disabled, false, "enabled before");
    s.attemptClose();
    await flush();
    assert.equal(s.closeBtn.disabled, true, "disabled during");

    d.resolve("blocked");
    await flush();
    assert.equal(s.closeBtn.disabled, false, "re-enabled after a blocked save");
    env.assertNoErrors();
  });
});

describe("every close route goes through attemptClose", () => {
  test("the × button, Escape and a backdrop click all save first", async () => {
    for (const route of ["button", "escape", "backdrop"]) {
      env.reset();
      const { ctx, calls } = saving("saved");
      const s = await openShell(ctx);

      if (route === "button") s.closeBtn.click();
      else if (route === "escape") s.key("Escape");
      else s.backdropClick();

      await flush();
      assert.deepEqual(calls, [false], `${route} did not route through the save`);
      assert.equal(s.it.open, false, `${route} did not close`);
      env.assertNoErrors();
    }
  });

  test("a drag started inside the card and released on the backdrop does NOT close", async () => {
    const { ctx, calls } = saving("saved");
    const s = await openShell(ctx);

    s.dragToBackdrop();
    await flush();

    assert.deepEqual(calls, [], "a drag-select must never trigger a save");
    assert.equal(s.it.open, true, "releasing a drag over the backdrop must not close");
    env.assertNoErrors();
  });

  test("Escape pops a layer instead of closing while one is open", async () => {
    const { ctx, calls } = saving("saved");
    const s = await openShell(ctx);
    const el = document.createElement("div");
    s.layers.pushLayer({ el });

    s.key("Escape");
    await flush();

    assert.equal(s.it.layers.length, 0, "Escape popped the layer");
    assert.equal(s.it.open, true, "and did not close the modal");
    assert.deepEqual(calls, []);
    env.assertNoErrors();
  });
});

describe("closeModal teardown", () => {
  test("drains layers, teardown steps and debounces, and hides the root", async () => {
    const cancelled = [];
    const s = await openShell({
      debounces: [
        { cancel: () => cancelled.push("a") },
        { cancel: () => cancelled.push("b") },
        null, // a pane that registered nothing must not break the loop
      ],
    });

    let torn = 0;
    s.it.teardown.push(() => torn++);
    s.layers.pushLayer({ el: document.createElement("div") });

    s.closeModal();

    assert.equal(s.it.layers.length, 0, "layer stack drained");
    assert.equal(torn, 1, "teardown steps ran");
    assert.deepEqual(cancelled, ["a", "b"], "every pane debounce cancelled");
    assert.equal(s.root.hidden, true);
    assert.equal(s.it.open, false);
    assert.equal(s.it.closing, false);
    assert.equal(s.closeBtn.disabled, false);
    env.assertNoErrors();
  });

  test("restores focus to whatever had it before the modal opened", async () => {
    const s = await openShell();
    const before = document.createElement("button");
    document.body.appendChild(before);
    s.it.previouslyFocused = before;

    s.closeModal();

    assert.equal(document.activeElement, before);
    assert.equal(s.it.previouslyFocused, null, "and does not hold the reference");
    env.assertNoErrors();
  });

  test("is idempotent — a second close is a no-op", async () => {
    const s = await openShell();
    s.closeModal();
    s.closeModal();
    assert.equal(s.it.open, false);
    env.assertNoErrors();
  });
});
