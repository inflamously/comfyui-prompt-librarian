/* ==========================================================================
   Near duplicates at save time — reported, never blocking

   There used to be a "Possible duplicate — nothing saved yet" dialog in the
   middle of the save path: a near match stopped the write and made the user
   pick merge / overwrite / keep-both before anything happened.

   It is gone. Saving creates by default now, so a near match costs an extra
   record rather than someone else's text, and the standing duplicate panel
   below the editor — amber, with `revise` on it — is where that gets resolved,
   on the user's own clock.

   These tests pin the new contract: the save goes through, no layer is opened
   from this path, and the outcome is not silent.

   createSave() is driven directly with a hand-built `pane`. The real pane is
   ~700 lines of unrelated rendering; the save flow only ever touches the
   dozen hooks faked below, and that is exactly the surface worth pinning.
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

/** A match row as the /dupes endpoint hands it over. */
function match(id, score = 0.97) {
  return { id, label: id + "_label", score, summary: "a word or two" };
}

/**
 * A minimal pane with recording stubs.
 *
 * @param {object} over  `matches` (what the check finds), `record` (what the
 *   pane is editing, null for a brand-new one), plus any hook override.
 */
async function makePane(over = {}) {
  const { resolveHelpers } = await imp(I + "helpers.js");
  const { createSave } = await imp(I + "save.js");

  const calls = { confirm: 0, create: 0, update: 0, toasts: [], layers: [], dupes: [] };
  const matches = over.matches || [];
  const record = "record" in over ? over.record : null;

  const ctx = {
    ABORTED: Symbol("aborted"),
    dom: {},
    API: {
      get: async (id) => ({ ok: true, record: { id, updated: "T0", body: "stored", tags: [] } }),
      dupes: async (p) => {
        calls.dupes.push(p);
        if (over.dupesFails) throw new Error("offline");
        return { ok: true, matches };
      },
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
    // Nothing on this path asks a question any more.
    confirmDialog: async () => {
      calls.confirm++;
      return true;
    },
  };

  const D = resolveHelpers(ctx);
  const pane = {
    ctx,
    D,
    calls,
    buf: { tags: [], body: "a body long enough to be worth checking" },
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
    runDupes() { calls.reran = (calls.reran || 0) + 1; },
    scheduleDupes: { cancel() {} },
    toast: (m) => calls.toasts.push(String(m)),
    adoptRecord(rec) {
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

describe("near duplicates do not block the save", () => {
  test("matches at or above the threshold are written anyway", async () => {
    const pane = await makePane({ matches: [match("a"), match("b")] });

    assert.equal(await pane.save(true), "saved");
    assert.equal(pane.calls.create, 1, "the record is written");
    assert.equal(pane.calls.layers.length, 0, "no dialog stands in the way");
    assert.equal(pane.calls.confirm, 0, "and nothing is asked");
    env.assertNoErrors();
  });

  test("the outcome is not silent — the panel is named", async () => {
    const pane = await makePane({ matches: [match("a"), match("b")] });
    await pane.save(true);

    assert.ok(
      pane.calls.toasts.some((t) => /2 near matches/.test(t) && /duplicate panel/.test(t)),
      "the toast points at the panel that is now amber: " + JSON.stringify(pane.calls.toasts),
    );
    assert.ok(pane.calls.reran > 0, "and the live check was re-run, so the panel is current");
    env.assertNoErrors();
  });

  test("matches below the threshold are not even mentioned", async () => {
    const pane = await makePane({ matches: [match("a", 0.5)] });

    assert.equal(await pane.save(true), "saved");
    assert.equal(pane.calls.layers.length, 0);
    assert.equal(pane.calls.toasts.filter((t) => /near match/.test(t)).length, 0);
    env.assertNoErrors();
  });

  test("a muted pair is saved quietly — the user already chose to keep both", async () => {
    const pane = await makePane({ matches: [{ ...match("a"), ignored: true }] });

    assert.equal(await pane.save(true), "saved");
    assert.equal(pane.calls.create, 1);
    assert.equal(pane.calls.toasts.filter((t) => /near match/.test(t)).length, 0);
    env.assertNoErrors();
  });

  test("an update stays an update — it must not fork into a copy", async () => {
    const rec = { id: "r1", updated: "T0", body: "stored", tags: [] };
    const pane = await makePane({ matches: [match("a")], record: rec });

    assert.equal(await pane.save(false), "saved");
    assert.equal(pane.calls.update, 1);
    assert.equal(pane.calls.create, 0);
    env.assertNoErrors();
  });

  test("a duplicate-check outage costs the report, not the save", async () => {
    const pane = await makePane({ matches: [match("a")], dupesFails: true });

    assert.equal(await pane.save(true), "saved");
    assert.equal(pane.calls.create, 1);
    env.assertNoErrors();
  });
});
