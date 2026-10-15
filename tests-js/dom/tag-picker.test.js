/* ==========================================================================
   features/tags on a real layer stack: the limit, unchecking, keys.
   ========================================================================== */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const { createTags } = await imp("prompt_librarian/features/tags/index.js");
const { LayerStack } = await imp("prompt_librarian/shared/ui/layer-stack.js");
const { installKeyGuards } = await imp("prompt_librarian/shared/keys.js");

let env, host, layers, toasts, uninstall;
beforeEach(() => {
  env = setupDom();
  host = document.createElement("div");
  document.body.append(host);
  layers = new LayerStack(host);
  toasts = [];
  uninstall = installKeyGuards(host);
});
afterEach(() => { uninstall(); env.assertNoErrors(); env.teardown(); });

const taxonomy = [{ name: "portrait", count: 4 }, { name: "night", count: 2 }];
const tags = () => createTags({ taxonomy: () => taxonomy, layers: () => layers, toast: (m, o) => toasts.push([m, o.kind]) });
const option = (pop, text) => [...pop.el.querySelectorAll(".pl-opt")].find((b) => b.textContent.includes(text));

test("it opens on the layer stack and toggles tags through the callbacks", () => {
  const picked = [], removed = [];
  const pop = tags().openPicker({ anchor: host, selected: ["night"], onPick: (t) => picked.push(t), onRemove: (t) => removed.push(t) });
  assert.equal(layers.top().el, pop.el);
  option(pop, "portrait").click();
  option(pop, "night").click();
  assert.deepEqual([picked, removed], [["portrait"], ["night"]]);
});

test("without onRemove a chosen tag stays chosen", () => {
  const pop = tags().openPicker({ anchor: host, selected: ["night"] });
  option(pop, "night").click();
  assert.equal(option(pop, "night").getAttribute("aria-selected"), "true");
});

test("the 33rd tag is refused with an error toast", () => {
  const selected = Array.from({ length: 32 }, (_, i) => `t${i}`);
  const picked = [];
  const pop = tags().openPicker({ anchor: host, selected, onPick: (t) => picked.push(t) });
  option(pop, "portrait").click();
  assert.deepEqual([picked, toasts], [[], [["32 tags is the limit", "error"]]]);
});

test("arrow keys reach the menu through the key bus, and Escape closes", () => {
  const picked = [];
  const pop = tags().openPicker({ anchor: host, onPick: (t) => picked.push(t) });
  const key = (k) => pop.el.querySelector("input").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  key("ArrowDown");
  key("Enter");
  assert.deepEqual(picked, ["night"], "row 2 after one ArrowDown");
  key("Escape");
  assert.deepEqual([pop.isOpen(), layers.size], [false, 0]);
});

test("after a click toggles a tag, focus is back in the filter, so keys still work", () => {
  const pop = tags().openPicker({ anchor: host, onPick() {} });
  option(pop, "portrait").click();
  assert.equal(document.activeElement, pop.el.querySelector("input"));
  pop.el.querySelector("input").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(pop.isOpen(), false);
});
