/* ==========================================================================
   Saving something the library already contains, character for character

   A near match no longer stops a save — it lights up the duplicate panel and
   the write goes through. A 1.00 match is different in kind: the two records
   would be the same text, so writing it adds a copy of a prompt the library
   already has, and there is nothing there to decide later either.

   So an exact match on the CREATE path adopts the stored record instead:
   no second record, the panel switches to the one that exists, and the save
   reports "clean" so the modal is free to close.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const I = "prompt_librarian/inspector/";

const BODY = "a body long enough to be worth checking";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

/**
 * @param {object} over `matches`, `record` (what is being edited), and
 *   `stored` (the body `GET /prompt` hands back for the match).
 */
async function makePane(over = {}) {
  const { resolveHelpers } = await imp(I + "helpers.js");
  const { createSave } = await imp(I + "save.js");

  const calls = { create: 0, update: 0, get: [], toasts: [], layers: [], adopted: [] };
  const record = "record" in over ? over.record : null;
  const stored = "stored" in over ? over.stored : BODY;

  const ctx = {
    ABORTED: Symbol("aborted"),
    dom: {},
    API: {
      get: async (id) => {
        calls.get.push(id);
        return { ok: true, record: { id, updated: "T0", body: id === (record && record.id) ? record.body : stored, tags: [] } };
      },
      dupes: async () => ({ ok: true, matches: over.matches || [] }),
      create: async (p) => {
        calls.create++;
        return { ok: true, record: { id: "new1", updated: "T1", body: p.body, tags: p.tags || [] } };
      },
      update: async (p) => {
        calls.update++;
        return { ok: true, record: { id: p.id, updated: "T1", body: p.body, tags: p.tags || [] } };
      },
      ignorePair: async () => ({ ok: true }),
    },
    confirmDialog: async () => true,
  };

  const pane = {
    ctx,
    calls,
    D: resolveHelpers(ctx),
    buf: { tags: [], body: BODY },
    current: record,
    baseline: record ? JSON.parse(JSON.stringify(record)) : null,
    disposed: false,
    saving: false,
    isDirty: () => true,
    threshold: () => 0.9,
    getBuffer: () => ({ tags: pane.buf.tags.slice(), body: pane.buf.body }),
    renderActions() {},
    focusBody() {},
    clearDraft() {},
    saveDraft() {},
    maybeOfferDraft() {},
    compareWith() {},
    compareConflict() {},
    runDupes() {},
    scheduleDupes: { cancel() {} },
    toast: (m) => calls.toasts.push(String(m)),
    adoptRecord(rec) {
      calls.adopted.push(rec.id);
      pane.current = rec;
      pane.baseline = JSON.parse(JSON.stringify(rec));
    },
    openLayer(el) {
      const layer = { el, closed: false, close: () => { layer.closed = true; } };
      calls.layers.push(layer);
      return layer;
    },
  };
  createSave(pane);
  return pane;
}

describe("an exact match on create", () => {
  test("adds nothing and selects the record that already holds the text", async () => {
    const pane = await makePane({ matches: [{ id: "a", label: "a_label", score: 1 }] });

    assert.equal(await pane.save(false), "clean");
    assert.equal(pane.calls.create, 0, "no second copy of the same prompt");
    assert.equal(pane.calls.layers.length, 0, "and no dialog: there was nothing to decide");
    assert.deepEqual(pane.calls.adopted, ["a"]);
    assert.ok(pane.calls.toasts.some((t) => /already saved/.test(t)));
    env.assertNoErrors();
  });

  test("`save as new` from an existing record is the same story", async () => {
    const rec = { id: "r1", updated: "T0", body: "something else entirely", tags: [] };
    const pane = await makePane({ matches: [{ id: "a", label: "a_label", score: 1 }], record: rec });

    assert.equal(await pane.save(true), "clean");
    assert.equal(pane.calls.create, 0);
    assert.deepEqual(pane.calls.adopted, ["a"]);
    env.assertNoErrors();
  });

  test("the score is only a hint — a body that turns out to differ is written", async () => {
    // The score was computed against a snapshot; `get` is the second opinion.
    // When it disagrees there is nothing to adopt, so the save is an ordinary
    // one: near matches report through the panel, they do not stop it.
    const pane = await makePane({
      matches: [{ id: "a", label: "a_label", score: 1 }],
      stored: "not actually the same text at all",
    });

    assert.equal(await pane.save(false), "saved");
    assert.equal(pane.calls.create, 1, "written, not adopted");
    assert.deepEqual(pane.calls.adopted, ["new1"], "the record it adopts is the one it just wrote");
    assert.equal(pane.calls.layers.length, 0, "and no dialog stands in the way");
    env.assertNoErrors();
  });

  test("a muted pair is left alone: the user already chose to keep both", async () => {
    const pane = await makePane({ matches: [{ id: "a", label: "a_label", score: 1, ignored: true }] });

    assert.equal(await pane.save(false), "saved");
    assert.equal(pane.calls.create, 1);
    env.assertNoErrors();
  });

  test("updating an existing record is untouched — it is a write, not a copy", async () => {
    const rec = { id: "r1", updated: "T0", body: "older text", tags: [] };
    const pane = await makePane({ matches: [{ id: "a", label: "a_label", score: 1 }], record: rec });

    // Adoption is a create-only shortcut: an update is a deliberate write to
    // a record the user has open, and must never be turned into "select that
    // other one instead".
    assert.equal(await pane.save(false), "saved", "an update writes");
    assert.equal(pane.calls.update, 1);
    assert.deepEqual(pane.calls.adopted, ["r1"], "it adopts its own write, never the match");
    env.assertNoErrors();
  });
});
