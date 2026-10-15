/* ==========================================================================
   features/browse: chips, tabs and the list's keys, on a real slice and the
   real key bus. dupe-accordion.test.js covers rows and clusters.
   ========================================================================== */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { flush } from "../harness/modal.js";

const { BrowsePane } = await imp("prompt_librarian/features/browse/index.js");
const { Store } = await imp("prompt_librarian/shared/store.js");
const { API } = await imp("prompt_librarian/api/routes.js");
const { installKeyGuards } = await imp("prompt_librarian/shared/keys.js");

const hit = (id) => ({ id, body: `prompt ${id}`, used: 0 });
let env, uninstall;
beforeEach(() => { env = setupDom(); });
afterEach(() => { uninstall?.(); env.assertNoErrors(); env.teardown(); });

async function mount() {
  env.api.route("/prompt_librarian/search", { hits: ["a", "b", "c"].map(hit), total: 3, record_total: 3 });
  env.api.route("/prompt_librarian/prompt", { prompt: { id: "b", body: "prompt b" } });
  const slice = new Store({
    browse: { query: { q: "", tags: [], dupesOnly: false, sort: "relevance" }, selection: new Set(), selectionMode: "ids", anchorIndex: null },
  }).slice("browse");
  const calls = { picker: [], selected: [], loaded: [], toasts: [] };
  const el = document.createElement("div");
  document.body.append(el);
  uninstall = installKeyGuards(el);
  const pane = new BrowsePane({
    api: API, slice,
    tags: { openPicker: (opts) => calls.picker.push(opts) },
    context: () => ({ threshold: 0.9, currentId: calls.selected.at(-1) ?? null }),
    onSelect: (id) => calls.selected.push(id),
    onLoad: (record) => { calls.loaded.push(record.id); return { ok: true }; },
    toast: (m) => calls.toasts.push(m),
    reportError: (err) => { throw err; },
  }).mount(el);
  await pane.refresh();
  return { pane, slice, calls, el };
}

const button = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent.includes(text));
const key = (el, k) => el.querySelector(".pl-list").dispatchEvent(
  new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

test("the rail keeps its four grid parts as the rail's own children", async () => {
  const { el } = await mount();
  const root = el.firstElementChild;
  assert.equal(root.style.display, "contents");
  assert.deepEqual([...root.children].map((c) => c.className), ["pl-search", "pl-chips", "pl-tabs", "pl-list"]);
});

test("+ tag opens the tags service without new-tag rows; picks and un-picks filter", async () => {
  const { el, slice, calls } = await mount();
  button(el, "+ tag").click();
  const opts = calls.picker[0];
  assert.equal(opts.allowNew, false);
  assert.equal(opts.anchor(), el.querySelector(".pl-chip-add"));
  opts.onPick("night");
  assert.deepEqual(slice.get("query").tags, ["night"]);
  assert.equal(opts.anchor(), el.querySelector(".pl-chip-add"), "the anchor follows the repainted chip");
  assert.ok(el.querySelector(".pl-chip.is-on"), "the tag shows as a chip");
  opts.onRemove("night");
  assert.deepEqual(slice.get("query").tags, []);
  await flush();
  assert.equal(env.api.callsTo("/search").at(-1).query.tags, undefined);
});

test("dupes only and the sort tabs set the query and search again", async () => {
  const { el, slice } = await mount();
  const before = env.api.callsTo("/search").length;
  button(el, "dupes only").click();
  el.querySelector('[data-sort="az"]').click();
  await flush();
  assert.deepEqual([slice.get("query").dupesOnly, slice.get("query").sort], [true, "az"]);
  assert.equal(el.querySelector('[data-sort="az"]').getAttribute("aria-selected"), "true");
  assert.equal(button(el, "dupes only").getAttribute("aria-pressed"), "true");
  assert.equal(env.api.callsTo("/search").length, before + 2);
});

test("arrow keys select through the key bus; Space ticks; Enter loads into the node", async () => {
  const { el, slice, calls } = await mount();
  key(el, "ArrowDown");
  key(el, "ArrowDown");
  assert.deepEqual(calls.selected, ["a", "b"]);
  key(el, " ");
  assert.deepEqual([...slice.get("selection")], ["b"]);
  key(el, "Enter");
  await flush();
  assert.deepEqual(calls.loaded, ["b"]);
  assert.match(calls.toasts.at(-1), /loaded ".*" into the node/);
});

test("typed search is debounced; clearing the box searches at once", async () => {
  const { el, pane } = await mount();
  const searches = () => env.api.callsTo("/search").length;
  const before = searches();
  const input = el.querySelector(".pl-search-in");
  for (const v of ["f", "fo", "fox"]) { input.value = v; input.dispatchEvent(new window.Event("input")); }
  assert.equal(searches(), before, "nothing during the burst");
  await flush(200);
  assert.equal(searches(), before + 1);
  input.value = "";
  input.dispatchEvent(new window.Event("input"));
  await flush();
  assert.equal(searches(), before + 2, "no 150 ms wait");
  pane.destroy();
  assert.equal(el.children.length, 0, "destroy takes the rail's DOM with it");
});
