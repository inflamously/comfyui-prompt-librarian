/* ==========================================================================
   Saving something the library already contains, character for character

   The gate treats every match the same: it asks. But a 1.00 match is not a
   question — the two records would be the same text, so "keep both" means
   "keep two copies of one prompt" and "merge" means merging a thing into
   itself. There is nothing to write.

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

  test("the score is only a hint — a body that turns out to differ still gates", async () => {
    // The score was computed against a snapshot; `get` is the second opinion.
    const pane = await makePane({
      matches: [{ id: "a", label: "a_label", score: 1 }],
      stored: "not actually the same text at all",
    });

    assert.equal(await pane.save(false), "blocked");
    assert.equal(pane.calls.create, 0);
    assert.equal(pane.calls.layers.length, 1, "the normal duplicate dialog");
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

    assert.equal(await pane.save(false), "blocked", "an update still asks");
    assert.equal(pane.calls.adopted.length, 0);
    env.assertNoErrors();
  });
});
