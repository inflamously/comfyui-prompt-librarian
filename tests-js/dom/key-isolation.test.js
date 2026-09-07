/* ==========================================================================
   Key isolation — the pack's stated top hazard

   ComfyUI installs document-level key handlers (Delete removes the selected
   node, Ctrl+C/V, space-pan, Enter queues a prompt). Typing a prompt body
   inside the overlay must not reach any of them.

   Two layers, because a document-capture listener registered by ComfyUI at
   startup would otherwise run before anything we can attach:

     Layer A — window CAPTURE, stopImmediatePropagation() for anything inside
               our root, then re-delivers through our own bus. NEVER
               preventDefault: that would break text entry.
     Layer B — root-level bubble stops.

   What these tests CANNOT prove: that our guard beats a listener ComfyUI
   registered first in a real install. They prove the mechanism, against a
   simulated adversary registered before us.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { openShell, flush } from "../harness/modal.js";
import { imp } from "../harness/mount.js";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

/** Stand in for ComfyUI: capture-phase listeners on document, registered first. */
function comfyui() {
  const seen = [];
  for (const type of ["keydown", "keyup", "keypress"]) {
    document.addEventListener(type, (e) => seen.push(`${type}:${e.key}`), true);
  }
  return seen;
}

describe("key isolation", () => {
  test("keystrokes inside the overlay never reach ComfyUI", async () => {
    const heard = comfyui();
    const s = await openShell();

    const ta = document.createElement("textarea");
    s.els.inspect.appendChild(ta);

    for (const type of ["keydown", "keyup", "keypress"]) {
      ta.dispatchEvent(new KeyboardEvent(type, { key: "a", bubbles: true, cancelable: true }));
    }
    // Delete and Enter are the two that would destroy work on the canvas.
    s.keyOn(ta, "Delete");
    s.keyOn(ta, "Enter");

    assert.deepEqual(heard, [], "ComfyUI heard a keystroke meant for the panel");
    env.assertNoErrors();
  });

  test("keystrokes outside the overlay still reach ComfyUI", async () => {
    const heard = comfyui();
    await openShell();

    const outside = document.createElement("input");
    document.body.appendChild(outside);
    outside.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true }));

    assert.deepEqual(heard, ["keydown:q"], "the guard must not swallow the whole page");
    env.assertNoErrors();
  });

  test("typing is never preventDefault-ed by the guard", async () => {
    // Layer A explicitly must not preventDefault, or the textarea stops
    // receiving characters.
    const s = await openShell();
    const ta = document.createElement("textarea");
    s.els.inspect.appendChild(ta);

    const ev = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);

    assert.equal(ev.defaultPrevented, false);
    env.assertNoErrors();
  });

  test("the bus runs capture root→target, then bubble target→root", async () => {
    const { onKey } = await imp("prompt_librarian/prompt_modal/input/keys.js");
    const s = await openShell();

    const mid = document.createElement("div");
    const leaf = document.createElement("textarea");
    mid.appendChild(leaf);
    s.els.inspect.appendChild(mid);

    const order = [];
    onKey(s.root, "keydown", () => order.push("root-capture"), { capture: true });
    onKey(mid, "keydown", () => order.push("mid-capture"), { capture: true });
    onKey(leaf, "keydown", () => order.push("leaf-capture"), { capture: true });
    onKey(leaf, "keydown", () => order.push("leaf-bubble"));
    onKey(mid, "keydown", () => order.push("mid-bubble"));
    onKey(s.root, "keydown", () => order.push("root-bubble"));

    s.keyOn(leaf, "a");

    assert.deepEqual(order, [
      "root-capture",
      "mid-capture",
      "leaf-capture",
      "leaf-bubble",
      "mid-bubble",
      "root-bubble",
    ]);
    env.assertNoErrors();
  });

  test("stopPropagation and stopImmediatePropagation work on the bus", async () => {
    const { onKey } = await imp("prompt_librarian/prompt_modal/input/keys.js");
    const s = await openShell();
    const leaf = document.createElement("textarea");
    s.els.inspect.appendChild(leaf);

    let order = [];
    onKey(leaf, "keydown", (e) => {
      order.push("first");
      e.stopImmediatePropagation();
    });
    onKey(leaf, "keydown", () => order.push("second-same-level"));
    onKey(s.root, "keydown", () => order.push("root"));

    s.keyOn(leaf, "a");
    assert.deepEqual(order, ["first"], "stopImmediatePropagation stops this level too");

    env.assertNoErrors();
  });

  test("a throwing bus handler is logged and does not stop the others", async () => {
    env.expectError(/key handler failed/);
    const { onKey } = await imp("prompt_librarian/prompt_modal/input/keys.js");
    const s = await openShell();
    const leaf = document.createElement("textarea");
    s.els.inspect.appendChild(leaf);

    const order = [];
    onKey(leaf, "keydown", () => {
      order.push("thrower");
      throw new Error("boom");
    });
    onKey(leaf, "keydown", () => order.push("survivor"));

    s.keyOn(leaf, "a");
    assert.deepEqual(order, ["thrower", "survivor"]);
    assert.equal(env.errors.length, 1);
  });

  test("preventDefault from a bus handler reaches the original event", async () => {
    // The reason the guard delivers the original object rather than a clone.
    const { onKey } = await imp("prompt_librarian/prompt_modal/input/keys.js");
    const s = await openShell();
    const leaf = document.createElement("textarea");
    s.els.inspect.appendChild(leaf);

    onKey(leaf, "keydown", (e) => e.preventDefault());
    const ev = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    leaf.dispatchEvent(ev);

    assert.equal(ev.defaultPrevented, true);
    env.assertNoErrors();
  });

  test("the pl:keydown mirror carries the original event", async () => {
    const s = await openShell();
    const leaf = document.createElement("textarea");
    s.els.inspect.appendChild(leaf);

    let detail = null;
    leaf.addEventListener("pl:keydown", (e) => {
      detail = e.detail;
    });
    const ev = new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true });
    leaf.dispatchEvent(ev);

    assert.ok(detail, "no mirror event was dispatched");
    assert.equal(detail.event, ev, "the mirror must reference the original");
    env.assertNoErrors();
  });

  test("closing removes BOTH layers — no listener leak", async () => {
    // removeEventListener only matches an identical capture flag, and a leaked
    // window-capture guard would swallow every keystroke on the page forever.
    const s = await openShell();
    const ta = document.createElement("textarea");
    s.els.inspect.appendChild(ta);

    const heard = comfyui();
    s.keyOn(ta, "a");
    assert.deepEqual(heard, [], "guarded while open");

    s.closeModal();
    await flush();

    s.keyOn(ta, "b");
    assert.deepEqual(heard, ["keydown:b"], "the guard outlived the modal");
    env.assertNoErrors();
  });
});
