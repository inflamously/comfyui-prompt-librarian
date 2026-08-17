/* ==========================================================================
   Layer scrims

   A layer on the stack must swallow clicks aimed at everything beneath it —
   the card, and any layer pushed before it. That is done with one scrim per
   layer, appended immediately before the layer's own element so DOM order
   alone gives the stacking. These tests pin the invariant that matters: for
   every live layer there is exactly one scrim under it, and popping a layer
   takes its scrim with it.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { openShell } from "../harness/modal.js";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

/** The children of .pl-layers as a list of class names. */
function stack(els) {
  return Array.from(els.layers.children).map((n) => n.className);
}

describe("layer scrims", () => {
  test("a pushed layer is preceded by its own scrim", async () => {
    const { els, layers } = await openShell();
    const el = env.document.createElement("div");
    el.className = "pl-dialog";
    layers.pushLayer({ el, closeOnOutside: false });

    assert.deepEqual(stack(els), ["pl-layer-scrim is-dim", "pl-dialog"]);
  });

  test("a second layer gets a scrim over the first", async () => {
    const { els, layers } = await openShell();
    const one = env.document.createElement("div");
    one.className = "pl-dialog one";
    const two = env.document.createElement("div");
    two.className = "pl-dialog two";
    layers.pushLayer({ el: one, closeOnOutside: false });
    layers.pushLayer({ el: two, closeOnOutside: false });

    assert.deepEqual(stack(els), [
      "pl-layer-scrim is-dim",
      "pl-dialog one",
      "pl-layer-scrim is-dim",
      "pl-dialog two",
    ]);
  });

  test("popping a layer removes its scrim", async () => {
    const { els, layers } = await openShell();
    const one = env.document.createElement("div");
    one.className = "pl-dialog one";
    const two = env.document.createElement("div");
    two.className = "pl-dialog two";
    const h1 = layers.pushLayer({ el: one, closeOnOutside: false });
    layers.pushLayer({ el: two, closeOnOutside: false });

    layers.popLayer(); // top
    assert.deepEqual(stack(els), ["pl-layer-scrim is-dim", "pl-dialog one"]);

    layers.popLayer(h1);
    assert.deepEqual(stack(els), []);
  });

  test("scrim:false opts out", async () => {
    const { els, layers } = await openShell();
    const el = env.document.createElement("div");
    el.className = "pl-popover";
    layers.pushLayer({ el, scrim: false });

    assert.deepEqual(stack(els), ["pl-popover"]);
  });
});
