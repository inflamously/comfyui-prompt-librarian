/* ==========================================================================
   Switching prompts with unsaved edits

   Picking another row in the sidebar used to park the edit in a sessionStorage
   draft and switch away silently. The draft bar does surface it again — but
   only if the user happens to return to that exact record, so from where they
   stand the edit had simply vanished.

   The inspector now asks first, and the three answers are the contract these
   tests pin:

       "Save"          commit, and only switch when the commit LANDED
       "Discard"       drop the buffer AND the parked draft
       "Keep editing"  stay put, and put `currentId` back on the record that
                       is still in the editor

   The real pane is mounted (not a hand-built one): the gate sits on the same
   path as the fetch, the draft parking and the state round-trip, and those
   interactions are the whole point.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const I = "prompt_librarian/inspector/";
const M = "prompt_librarian/modal/";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

function record(id, body) {
  return { id, updated: "T0", body, tags: [], label: id + "_label" };
}

/**
 * Mount the real inspector on a hand-built ctx.
 *
 * `answer` is what the gate's dialog resolves to; `asks` records every call so
 * a test can assert the dialog did NOT open on a clean buffer.
 */
async function mount({ answer = "cancel", records = {}, api = {} } = {}) {
  const { mountInspector } = await imp(I + "index.js");

  const calls = { asks: [], update: [], create: [], state: [], drafts: [], cleared: [] };
  const store = { ...records };

  const ctx = {
    ABORTED: Symbol("aborted"),
    dom: {},
    API: {
      get: async (id) =>
        store[id] ? { ok: true, record: store[id] } : { ok: false, error: "not found" },
      dupes: async () => ({ ok: true, matches: [] }),
      update: async (p) => {
        calls.update.push(p);
        return { ok: true, record: { ...store[p.id], ...p, updated: "T1" } };
      },
      create: async (p) => {
        calls.create.push(p);
        return { ok: true, record: record("new1", p.body) };
      },
      ...api,
    },
    setState(patch) {
      calls.state.push(patch);
    },
    saveDraft: (id, buf) => calls.drafts.push([id, buf]),
    loadDraft: () => null,
    clearDraft: (id) => calls.cleared.push(id),
    choiceDialog: async (opts) => {
      calls.asks.push(opts);
      return answer;
    },
    confirmDialog: async () => true,
    toast: () => {},
  };

  const el = document.createElement("div");
  document.body.appendChild(el);
  const pane = mountInspector(el, ctx);

  return { pane, ctx, calls, store };
}

/** Adopt `rec` as the selection, then type over it so the buffer is dirty. */
async function editing(h, rec, text = "an edited body") {
  await h.pane.selectPrompt(rec.id);
  h.pane.setBody(text);
  assert.equal(h.pane.isDirty(), true, "precondition: the buffer must be dirty");
  h.calls.asks.length = 0;
  h.calls.state.length = 0;
}

describe("the unsaved-changes gate", () => {
  test("a clean buffer switches with no dialog at all", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    const h = await mount({ records: { a, b } });

    await h.pane.selectPrompt("a");
    h.calls.asks.length = 0;
    await h.pane.selectPrompt("b");

    assert.equal(h.calls.asks.length, 0, "nothing to lose, nothing to ask");
    assert.equal(h.pane.getBuffer().body, "second");
  });

  test("re-picking the record already open never asks", async () => {
    const a = record("a", "first");
    const h = await mount({ records: { a } });
    await editing(h, a);

    await h.pane.selectPrompt("a");
    assert.equal(h.calls.asks.length, 0);
    assert.equal(h.pane.getBuffer().body, "an edited body", "the edit survives");
  });

  test("Keep editing stays on the record and restores currentId", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    const h = await mount({ answer: "cancel", records: { a, b } });
    await editing(h, a);

    await h.pane.selectPrompt("b");

    assert.equal(h.calls.asks.length, 1, "the gate asked");
    assert.equal(h.pane.getBuffer().body, "an edited body", "the edit is untouched");
    const restored = h.calls.state.filter((p) => "currentId" in p).pop();
    assert.deepEqual(restored, { currentId: "a" }, "the sidebar highlight follows the editor");
  });

  test("Discard drops the buffer and the parked draft, then switches", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    const h = await mount({ answer: "discard", records: { a, b } });
    await editing(h, a);

    await h.pane.selectPrompt("b");

    assert.equal(h.pane.getBuffer().body, "second", "the switch happened");
    assert.ok(h.calls.cleared.includes("a"), "discard means gone — no draft left behind");
    assert.equal(h.calls.drafts.length, 0, "and nothing was parked on the way out");
    assert.equal(h.calls.update.length, 0, "nothing was written");
  });

  test("Save commits first and then switches", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    const h = await mount({ answer: "save", records: { a, b } });
    await editing(h, a);

    await h.pane.selectPrompt("b");

    assert.equal(h.calls.update.length, 1, "the edit was committed as an update");
    assert.equal(h.calls.update[0].body, "an edited body");
    assert.equal(h.calls.create.length, 0, "an existing record updates, never saves-as-new");
    assert.equal(h.pane.getBuffer().body, "second");
  });

  test("a blocked save keeps the user on the record", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    // The record moved under the editor, so the save stops at the staleness
    // check and puts its own conflict dialog on screen: "blocked".
    const h = await mount({ answer: "save", records: { a, b } });
    await editing(h, a);
    h.store.a = { ...a, updated: "T9", body: "someone else's edit" };

    await h.pane.selectPrompt("b");

    assert.equal(h.calls.update.length, 0, "a stale record is never overwritten");
    assert.equal(h.pane.getBuffer().body, "an edited body", "the conflict dialog keeps its record");
    const restored = h.calls.state.filter((p) => "currentId" in p).pop();
    assert.deepEqual(restored, { currentId: "a" });
  });

  test("a failed save keeps the user on the record too", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    const h = await mount({
      answer: "save",
      records: { a, b },
      api: { update: async () => { throw new Error("server said no"); } },
    });
    await editing(h, a);

    await h.pane.selectPrompt("b");
    assert.equal(h.pane.getBuffer().body, "an edited body");
  });

  test("a second row clicked while the dialog is up is ignored", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    const c = record("c", "third");
    const h = await mount({ answer: "cancel", records: { a, b, c } });
    await editing(h, a);

    const first = h.pane.selectPrompt("b");
    const second = h.pane.selectPrompt("c");
    await Promise.all([first, second]);

    assert.equal(h.calls.asks.length, 1, "one question at a time");
  });

  test("an unsaved buffer with no record is offered as Save as new", async () => {
    const h = await mount({ answer: "save", records: { a: record("a", "x") } });
    h.pane.setBody("typed straight into the box");
    h.calls.asks.length = 0;

    await h.pane.selectPrompt("a");

    assert.equal(h.calls.asks.length, 1);
    assert.equal(h.calls.asks[0].choices.some((c) => c.label === "Save as new"), true);
    assert.equal(h.calls.create.length, 1, "no record to update — it must save as new");
  });

  test("without choiceDialog the old park-a-draft behaviour is kept", async () => {
    const a = record("a", "first");
    const b = record("b", "second");
    const h = await mount({ records: { a, b } });
    delete h.ctx.choiceDialog;
    await editing(h, a);

    await h.pane.selectPrompt("b");

    assert.equal(h.pane.getBuffer().body, "second", "an older modal must still switch");
    assert.ok(h.calls.drafts.some((d) => d[0] === "a"), "and the edit is parked, not dropped");
  });
});
