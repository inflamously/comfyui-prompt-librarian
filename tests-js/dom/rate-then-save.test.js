/* ==========================================================================
   Rating is not a remote edit

   The server stamps `updated` on a rating change. The pane used to copy only
   the new rating into its baseline, so the next Save compared the stale
   `updated` against the fresh record and reported "This prompt changed
   elsewhere" for a change the user had just made themselves.

   The rule these tests pin: a rating response re-baselines `updated` only
   when the server's record is otherwise what the pane loaded. A body changed
   in another tab must still surface as a conflict.
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

async function mount(rec) {
  const { mountInspector } = await imp(I + "index.js");
  const calls = { update: [], layers: 0 };
  const store = { [rec.id]: { ...rec } };
  let clock = 0;

  const ctx = {
    ABORTED: Symbol("aborted"),
    dom: {},
    API: {
      get: async (id) => ({ ok: true, record: { ...store[id] } }),
      dupes: async () => ({ ok: true, matches: [] }),
      rate: async (id, rating) => {
        store[id] = { ...store[id], rating, updated: "R" + ++clock };
        return { ok: true, record: { ...store[id] } };
      },
      update: async (p) => {
        calls.update.push(p);
        if (p.expect_updated !== store[p.id].updated) return { error: "stale", code: "conflict" };
        store[p.id] = { ...store[p.id], ...p, updated: "U" + ++clock };
        return { ok: true, record: { ...store[p.id] } };
      },
    },
    setState() {},
    saveDraft() {},
    loadDraft: () => null,
    clearDraft() {},
    toast: () => {},
  };

  const el = document.createElement("div");
  document.body.appendChild(el);
  const pane = mountInspector(el, ctx);
  await pane.selectPrompt(rec.id);
  return { pane, calls, store, el };
}

/** Click the n-th star the way a user does, then let the rating request land. */
async function rate(h, n) {
  h.el.querySelector(`[data-i="${n}"]`).click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const conflictShown = () => /changed elsewhere/.test(document.body.textContent);

describe("rate, then save", () => {
  test("a rating does not make the user's own next save a conflict", async () => {
    const h = await mount({ id: "a", body: "first", tags: [], rating: 0, updated: "T0" });

    await rate(h, 4);
    h.pane.setBody("first, edited");
    const status = await h.pane.requestSave(false);

    assert.equal(status, "saved");
    assert.equal(conflictShown(), false, "no conflict dialog for our own rating");
    assert.equal(h.calls.update.length, 1);
    assert.equal(h.store.a.body, "first, edited");
    assert.equal(h.store.a.rating, 4, "the rating survives the body save");
  });

  test("two ratings in a row still leave the save clean", async () => {
    const h = await mount({ id: "a", body: "first", tags: [], rating: 0, updated: "T0" });

    await rate(h, 2);
    await rate(h, 5);
    h.pane.setBody("second body");

    assert.equal(await h.pane.requestSave(false), "saved");
    assert.equal(conflictShown(), false);
  });

  test("a body changed elsewhere before the rating is still a conflict", async () => {
    const h = await mount({ id: "a", body: "first", tags: [], rating: 0, updated: "T0" });

    // Another tab rewrote the body after we loaded it.
    h.store.a = { ...h.store.a, body: "their body", updated: "X1" };
    await rate(h, 3);
    h.pane.setBody("my body");

    assert.equal(await h.pane.requestSave(false), "blocked");
    assert.equal(conflictShown(), true, "the remote edit must not be masked by our rating");
    assert.equal(h.store.a.body, "their body", "nothing was overwritten");
  });
});
