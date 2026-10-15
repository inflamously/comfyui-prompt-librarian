/* ==========================================================================
   features/inspector: the parts the flow tests do not reach — drafts, delete,
   the compare links, capabilities, the currentId subscription and teardown.
   ========================================================================== */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { mountInspector } from "../harness/inspector.js";
import { flush } from "../harness/modal.js";

let env;
beforeEach(() => { env = setupDom(); });
afterEach(() => { env.assertNoErrors(); env.teardown(); });

const rec = (id, body, over = {}) => ({ id, body, tags: [], updated: "T0", ...over });

async function mount(over = {}) {
  const store = { a: rec("a", "first"), b: rec("b", "second") };
  const calls = { compare: [], deleted: [], refreshed: 0, toasts: [], cleared: [] };
  const h = await mountInspector({
    api: {
      get: async (id) => ({ ok: true, record: { ...store[id] } }),
      dupes: async () => ({ ok: true, matches: [] }),
      del: async (id) => { calls.deleted.push(id); return { ok: true }; },
    },
    compare: {
      versions: (o) => calls.compare.push(["versions", o]),
      compare: (o) => calls.compare.push(["compare", o]),
    },
    drafts: { save() {}, load: (id) => (id === "a" ? { body: "a parked edit", tags: [] } : null), clear: (id) => calls.cleared.push(id) },
    toast: (m) => { calls.toasts.push(m); return null; },
    onLibraryChanged: () => { calls.refreshed++; },
    ...over,
  });
  return { ...h, calls, store };
}

const button = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent === text);

test("a parked draft is offered, and restore puts it in the editor", async () => {
  const h = await mount();
  await h.pane.selectPrompt("a");
  assert.equal(h.pane.els.draftBar.hidden, false);
  assert.match(h.pane.els.draftText.textContent, /13 chars/);
  button(h.el, "restore draft").click();
  assert.equal(h.pane.getBuffer().body, "a parked edit");
  assert.equal(h.pane.els.draftBar.hidden, true);
});

test("discard drops the offered draft and its stored copy", async () => {
  const h = await mount();
  await h.pane.selectPrompt("a");
  button(h.el, "discard").click();
  assert.equal(h.pane.els.draftBar.hidden, true);
  assert.deepEqual(h.calls.cleared, ["a"]);
  assert.equal(h.pane.getBuffer().body, "first");
});

test("delete confirms, deletes, clears the editor and refreshes the library", async () => {
  const h = await mount();
  await h.pane.selectPrompt("b");
  button(h.el, "Delete").click();
  await flush();
  assert.deepEqual(h.calls.deleted, ["b"]);
  assert.equal(h.pane.current, null);
  assert.equal(h.calls.refreshed, 1);
  assert.match(h.calls.toasts.at(-1), /deleted/);
});

test("the compare links pass the saved and edited text; versions restores through adopt", async () => {
  const h = await mount();
  await h.pane.selectPrompt("b");
  h.pane.setBody("second, edited");
  button(h.el, "diff vs saved").click();
  assert.deepEqual(h.calls.compare[0], ["compare", { a_id: "b", a_text: "second", b_text: "second, edited", titleA: "saved", titleB: "editing" }]);
  button(h.el, "versions").click();
  const [, opts] = h.calls.compare[1];
  opts.onRestored({ record: rec("b", "an older body") });
  assert.equal(h.pane.getBuffer().body, "an older body");
});

test("missing capabilities disable their links", async () => {
  const h = await mount({ caps: () => ({ versions: false, compare: false }) });
  await h.pane.selectPrompt("b");
  assert.equal(button(h.el, "versions").disabled, true);
  assert.equal(button(h.el, "diff vs saved").disabled, true);
  assert.match(button(h.el, "versions").title, /not supported/);
});

test("a currentId set elsewhere (a row click) loads that record", async () => {
  const h = await mount();
  h.slice.set({ currentId: "b" });
  await flush();
  assert.equal(h.pane.getBuffer().body, "second");
  assert.equal(h.slice.get("current").id, "b", "and the record is published to the slice");
});

test("destroy closes a conflict dialog the pane opened and empties its host", async () => {
  const h = await mount();
  await h.pane.selectPrompt("a");
  h.pane.saveFlow.openConflict(rec("a", "theirs", { updated: "T9" }), false);
  assert.equal(h.layers.size, 1);
  h.pane.destroy();
  assert.equal(h.layers.size, 0);
  assert.equal(h.el.children.length, 0);
});
