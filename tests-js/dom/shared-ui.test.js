/* ==========================================================================
   shared/ui/ in isolation — layer stack, toasts, dialogs, popovers.

   No modal, no ctx: each widget gets a bare host element, which is the point
   of these living in shared/ui/.
   ========================================================================== */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { flush } from "../harness/modal.js";

const U = "prompt_librarian/shared/ui/";
const { LayerStack } = await imp(U + "layer-stack.js");
const { Toaster } = await imp(U + "toast.js");
const { choose, confirm } = await imp(U + "dialog.js");
const { openPopover } = await imp(U + "popover.js");
const { Component } = await imp("prompt_librarian/shared/component.js");
const { installKeyGuards } = await imp("prompt_librarian/shared/keys.js");

let env;
let host;
beforeEach(() => {
  env = setupDom();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => { env.assertNoErrors(); env.teardown(); });

const button = (scope, text) => [...scope.querySelectorAll("button")].find((b) => b.textContent === text);

test("the stack mounts a component behind its scrim and destroys it on pop", () => {
  const layers = new LayerStack(host);
  let destroyed = 0;
  class Box extends Component {
    render() { return document.createElement("section"); }
    destroy() { destroyed++; super.destroy(); }
  }
  const closed = [];
  const layer = layers.push({ component: new Box(), onClose: () => closed.push("box") });
  assert.deepEqual([...host.children].map((n) => n.className || n.tagName), ["pl-layer-scrim", "SECTION"]);
  assert.equal(layers.top(), layer);

  layers.pop(layer);
  layers.pop(layer);
  assert.equal(host.children.length, 0);
  assert.deepEqual([destroyed, closed], [1, ["box"]], "a second pop of the same layer is a no-op");
});

test("pushing focuses the layer's first control; popping returns focus inside root", () => {
  const before = document.createElement("button");
  host.append(before);
  before.focus();
  const layers = new LayerStack(host);
  const el = document.createElement("div");
  const inner = document.createElement("button");
  inner.tabIndex = 0; // jsdom has no layout, so focusables() needs an explicit tabindex
  el.append(inner);
  layers.push({ el });
  assert.equal(document.activeElement, inner);
  layers.pop();
  assert.equal(document.activeElement, before);
});

test("clear() closes every layer, topmost first", () => {
  const layers = new LayerStack(host);
  const order = [];
  for (const name of ["a", "b"]) {
    layers.push({ el: document.createElement("div"), onClose: () => order.push(name) });
  }
  layers.clear();
  assert.deepEqual([order, layers.size], [["b", "a"], 0]);
});

test("toasts stack, leave after their time, and clear() removes them at once", async () => {
  const toaster = new Toaster(host);
  const err = toaster.show("bad", { kind: "error", ms: 0 });
  toaster.show("quick", { ms: 1 });
  assert.equal(err.getAttribute("aria-live"), "assertive");
  assert.equal(toaster.size, 2);
  await flush(260);
  assert.deepEqual([toaster.size, host.textContent], [1, "bad"], "the timed one left; ms: 0 stays");
  toaster.clear();
  assert.deepEqual([toaster.size, host.children.length], [0, 0]);
});

test("choose() resolves with the picked value, then closes", async () => {
  const layers = new LayerStack(host);
  const picked = choose(layers, {
    title: "Merge?",
    message: "two\nlines",
    choices: [{ value: "keep", label: "Keep" }, { value: "drop", label: "Drop", danger: true }],
  });
  assert.equal(host.querySelectorAll(".pl-dialog-body > div").length, 2);
  assert.ok(button(host, "Drop").classList.contains("pl-btn-danger"));
  button(host, "Drop").click();
  assert.equal(await picked, "drop");
  assert.equal(layers.size, 0);
});

test("a dialog popped from outside resolves with cancelValue", async () => {
  const layers = new LayerStack(host);
  const yes = confirm(layers, { confirmLabel: "Delete", danger: true });
  layers.pop();
  assert.equal(await yes, false);
  assert.equal(await choose(null, { cancelValue: "none" }), "none", "no stack: nothing to show");
});

test("a popover on the stack closes once, from the stack or from itself", () => {
  const layers = new LayerStack(host);
  const anchor = document.createElement("button");
  host.append(anchor);
  let closes = 0;
  const pop = openPopover({ anchor, layers, onClose: () => closes++, render: (el) => el.append("hi") });
  assert.equal(layers.top().el, pop.el);
  assert.equal(pop.el.textContent, "hi");

  layers.pop();
  pop.close();
  assert.deepEqual([closes, pop.isOpen(), layers.size], [1, false, 0]);
});

test("without a stack a popover listens for outside clicks itself", () => {
  const anchor = document.createElement("button");
  host.append(anchor);
  let closes = 0;
  const pop = openPopover({ anchor, onClose: () => closes++ });
  assert.equal(pop.el.parentNode, document.body);

  anchor.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(pop.isOpen(), true, "the anchor is not outside");
  host.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
  assert.deepEqual([pop.isOpen(), closes], [false, 1]);
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(closes, 1, "its listeners went with it");
});

test("Escape through the key bus closes the popover and nothing under it", () => {
  const uninstall = installKeyGuards(host);
  const layers = new LayerStack(host);
  const pop = openPopover({ anchor: host, layers });
  const ev = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  pop.el.dispatchEvent(ev);
  assert.deepEqual([pop.isOpen(), layers.size, ev.defaultPrevented], [false, 0, true]);
  uninstall();
});
