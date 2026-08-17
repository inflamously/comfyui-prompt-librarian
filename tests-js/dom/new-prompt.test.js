/* ==========================================================================
   The `New prompt` button

   Beside the derived label readout, because that row answers "which prompt am
   I editing" and "none yet" is an answer to the same question.

   What it has to do, and what these tests pin:

       clear the editor          buffer, tags, stats and the node all empty
       drop the selection        `current`/`currentId` go null, so Save creates
       ask before losing work    the same unsaved-changes gate a row click gets

   The real pane is mounted and the real button is clicked: the point is the
   wiring, not the function.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const I = "prompt_librarian/inspector/";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

function record(id, body) {
  return { id, updated: "T0", body, tags: ["a-tag"], label: id + "_label" };
}

async function mount({ answer = "cancel", records = {} } = {}) {
  const { mountInspector } = await imp(I + "index.js");

  const calls = { asks: [], update: [], create: [], state: [], pushed: [] };
  const store = { ...records };

  const ctx = {
    ABORTED: Symbol("aborted"),
    dom: {},
    API: {
      get: async (id) => (store[id] ? { ok: true, record: store[id] } : { ok: false, error: "not found" }),
      dupes: async () => ({ ok: true, matches: [] }),
      update: async (p) => { calls.update.push(p); return { ok: true, record: { ...store[p.id], ...p, updated: "T1" } }; },
      create: async (p) => { calls.create.push(p); return { ok: true, record: record("new1", p.body) }; },
    },
    setState(patch) { calls.state.push(patch); },
    pushToNode: (body, id) => { calls.pushed.push([body, id]); return { ok: true }; },
    saveDraft: () => {},
    loadDraft: () => null,
    clearDraft: () => {},
    choiceDialog: async (opts) => { calls.asks.push(opts); return answer; },
    confirmDialog: async () => true,
    toast: () => {},
  };

  const el = document.createElement("div");
  document.body.appendChild(el);
  const pane = mountInspector(el, ctx);

  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === "New prompt");
  assert.ok(btn, "the button must exist");

  /**
   * Click it and let everything it starts settle: the gate's promise chain,
   * and then the frame the outbound node push is throttled onto.
   */
  async function click() {
    btn.click();
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(r) : setTimeout(r, 20)));
    await new Promise((r) => setTimeout(r, 20));
  }

  return { pane, ctx, calls, store, el, btn, click };
}

describe("New prompt", () => {
  test("sits in the row with the label readout", async () => {
    const h = await mount();
    assert.equal(h.btn.closest(".pl-idrow"), h.el.querySelector(".pl-idrow"));
    assert.ok(h.el.querySelector(".pl-idrow .pl-label"), "next to the readout, not instead of it");
  });

  test("clears the editor and lets go of the record", async () => {
    const a = record("a", "first");
    const h = await mount({ records: { a } });
    await h.pane.selectPrompt("a");
    assert.equal(h.pane.getBuffer().body, "first");

    await h.click();

    assert.equal(h.pane.getBuffer().body, "", "the box is empty");
    assert.deepEqual(h.pane.getBuffer().tags, [], "and so are the tags");
    assert.equal(h.pane.isDirty(), false, "an empty new prompt is not an unsaved edit");
    const last = h.calls.state.filter((p) => "currentId" in p).pop();
    assert.deepEqual(last, { currentId: null }, "the sidebar highlight lets go");
  });

  test("clears the node's textarea too", async () => {
    const a = record("a", "first");
    const h = await mount({ records: { a } });
    await h.pane.selectPrompt("a");
    h.calls.pushed.length = 0;

    await h.click();

    assert.ok(h.calls.pushed.some((p) => p[0] === ""), "the canvas view is the same value");
  });

  test("the next save creates instead of overwriting", async () => {
    const a = record("a", "first");
    const h = await mount({ records: { a } });
    await h.pane.selectPrompt("a");
    await h.click();

    h.pane.setBody("a brand new prompt");
    await h.pane.requestSave(false);

    assert.equal(h.calls.update.length, 0, "the old record is never touched");
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.calls.create[0].body, "a brand new prompt");
  });

  test("a clean record needs no dialog", async () => {
    const a = record("a", "first");
    const h = await mount({ records: { a } });
    await h.pane.selectPrompt("a");
    h.calls.asks.length = 0;

    await h.click();

    assert.equal(h.calls.asks.length, 0);
  });

  test("Keep editing leaves an unsaved edit exactly where it was", async () => {
    const a = record("a", "first");
    const h = await mount({ answer: "cancel", records: { a } });
    await h.pane.selectPrompt("a");
    h.pane.setBody("half-written");
    h.calls.asks.length = 0;

    await h.click();

    assert.equal(h.calls.asks.length, 1, "the gate asked");
    assert.equal(h.pane.getBuffer().body, "half-written", "and the edit survived");
  });

  test("Save commits the edit before clearing", async () => {
    const a = record("a", "first");
    const h = await mount({ answer: "save", records: { a } });
    await h.pane.selectPrompt("a");
    h.pane.setBody("worth keeping");

    await h.click();

    assert.equal(h.calls.update.length, 1);
    assert.equal(h.calls.update[0].body, "worth keeping");
    assert.equal(h.pane.getBuffer().body, "", "and then the box is empty");
  });
});
