/* ==========================================================================
   shared/timing.js — pure, no-DOM.
   ========================================================================== */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const { debounce, rafThrottle } = await imp("prompt_librarian/shared/timing.js");

describe("debounce", () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  test("coalesces a burst into one trailing call with the last arguments", async () => {
    const seen = [];
    const d = debounce((v) => seen.push(v), 10);
    d(1);
    d(2);
    d(3);
    assert.deepEqual(seen, [], "nothing fires during the burst");
    await tick(30);
    assert.deepEqual(seen, [3], "last arguments win");
  });

  test("leading:true fires immediately and suppresses the trailing call", async () => {
    const seen = [];
    const d = debounce((v) => seen.push(v), 10, { leading: true });
    d("a");
    assert.deepEqual(seen, ["a"], "fires on the first call of a burst");
    d("b");
    await tick(30);
    assert.deepEqual(seen, ["a", "b"], "the burst's trailing call still lands once");
  });

  test("cancel() drops the pending call", async () => {
    const seen = [];
    const d = debounce((v) => seen.push(v), 10);
    d(1);
    assert.equal(d.pending(), true);
    d.cancel();
    assert.equal(d.pending(), false);
    await tick(30);
    assert.deepEqual(seen, [], "closeModal() relies on this to stop late writes");
  });

  test("flush() runs the pending call now and returns its value", async () => {
    const seen = [];
    const d = debounce((v) => {
      seen.push(v);
      return v * 2;
    }, 50);
    d(21);
    assert.equal(d.flush(), 42);
    assert.deepEqual(seen, [21]);
    assert.equal(d.pending(), false);
    await tick(70);
    assert.deepEqual(seen, [21], "and does not fire again afterwards");
  });

  test("cancel() and flush() are no-ops when nothing is pending", () => {
    const d = debounce(() => 1, 10);
    assert.doesNotThrow(() => d.cancel());
    assert.doesNotThrow(() => d.flush());
    assert.equal(d.pending(), false);
  });

  test("preserves `this`", async () => {
    const obj = {
      n: 0,
      bump: null,
    };
    obj.bump = debounce(function () {
      this.n++;
    }, 5);
    obj.bump();
    await tick(20);
    assert.equal(obj.n, 1);
  });
});

describe("rafThrottle", () => {
  test("collapses many calls per frame into one, last arguments winning", async () => {
    const seen = [];
    const t = rafThrottle((v) => seen.push(v));
    t(1);
    t(2);
    t(3);
    assert.deepEqual(seen, [], "nothing runs synchronously");
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, [3]);
  });

  test("cancel() prevents a queued frame from running", async () => {
    const seen = [];
    const t = rafThrottle((v) => seen.push(v));
    t(1);
    t.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, []);
  });

  test("falls back to a timer when requestAnimationFrame is absent", async () => {
    // The path taken in a headless/Node context — no globals installed here.
    assert.equal(typeof globalThis.requestAnimationFrame, "undefined");
    const seen = [];
    const t = rafThrottle(() => seen.push(1));
    t();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, [1]);
  });
});
