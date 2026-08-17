/* ==========================================================================
   The save-time duplicate gate — and getting back OUT of it

   The gate itself is well covered by intent: a near-duplicate stops the save
   and puts a dialog on screen. What was not covered is the exit. `save anyway`
   used to open a SECOND confirm and then leave every pair flagged, so the next
   save — and closing the modal is a save — re-ran the gate, found the same
   matches, and re-opened the same dialog. Forever.

   These tests pin the exit: one click, no follow-up dialog, and every pair the
   dialog listed is muted so it cannot come back.

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
 * @param {object} over  `matches` (what the gate finds), `record` (what the
 *   pane is editing, null for a brand-new one), plus any hook override.
 */
async function makePane(over = {}) {
  const { resolveHelpers } = await imp(I + "helpers.js");
  const { createSave } = await imp(I + "save.js");

  const calls = { ignorePair: [], confirm: 0, create: 0, update: 0, toasts: [], layers: [] };
  const matches = over.matches || [];
  const record = "record" in over ? over.record : null;

  const ctx = {
    ABORTED: Symbol("aborted"),
    dom: {},
    API: {
      get: async (id) => ({ ok: true, record: { id, updated: "T0", body: "stored", tags: [] } }),
      dupes: async () => ({ ok: true, matches }),
      create: async (p) => {
        calls.create++;
        return { ok: true, record: { id: "new1", updated: "T1", body: p.body, tags: p.tags || [] } };
      },
      update: async (p) => {
        calls.update++;
        return { ok: true, record: { id: p.id, updated: "T1", body: p.body, tags: p.tags || [] } };
      },
      ignorePair: async (a, b) => {
        calls.ignorePair.push([a, b]);
        if (over.ignoreFails) throw new Error("nope");
        return { ok: true };
      },
    },
    // Any call here is a failure for `save anyway`: the resolve dialog already
    // named every match, so there is nothing left to ask.
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
    runDupes() {},
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

/** The one button in `el` whose text is exactly `label`. */
function button(el, label) {
  const hit = [...el.querySelectorAll("button")].filter((b) => b.textContent === label);
  assert.equal(hit.length, 1, `expected exactly one "${label}" button, found ${hit.length}`);
  return hit[0];
}

describe("the duplicate gate blocks the save", () => {
  test("matches at or above the threshold open the dialog and write nothing", async () => {
    const pane = await makePane({ matches: [match("a"), match("b")] });

    assert.equal(await pane.save(false), "blocked");
    assert.equal(pane.calls.create, 0, "nothing is written until the user picks");
    assert.equal(pane.calls.update, 0);
    assert.equal(pane.calls.layers.length, 1, "exactly one dialog");
    env.assertNoErrors();
  });

  test("matches below the threshold do not gate", async () => {
    const pane = await makePane({ matches: [match("a", 0.5)] });

    assert.equal(await pane.save(false), "saved");
    assert.equal(pane.calls.layers.length, 0);
    env.assertNoErrors();
  });
});

describe("save anyway", () => {
  test("is the LAST dialog: one click saves, with no second confirm", async () => {
    const pane = await makePane({ matches: [match("a"), match("b")] });
    await pane.save(false);
    const dlg = pane.calls.layers[0];

    button(dlg.el, "save anyway").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(pane.calls.confirm, 0, "the resolve dialog already named every match");
    assert.equal(pane.calls.create, 1, "the record is written");
    assert.equal(dlg.closed, true, "and the dialog is gone");
    assert.equal(pane.calls.layers.length, 1, "no further dialog was opened");
    env.assertNoErrors();
  });

  test("mutes every pair it listed, so the same matches cannot gate again", async () => {
    const pane = await makePane({ matches: [match("a"), match("b"), match("c")] });
    await pane.save(false);

    button(pane.calls.layers[0].el, "save anyway").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(
      pane.calls.ignorePair.map(([, other]) => other).sort(),
      ["a", "b", "c"],
      "every listed match is muted against the saved record",
    );
    assert.ok(
      pane.calls.ignorePair.every(([mine]) => mine === "new1"),
      "muted against the id the save just minted, not a stale one",
    );
    assert.ok(
      pane.calls.toasts.some((t) => /stop being flagged/.test(t)),
      "and the user is told the nagging has stopped",
    );
    env.assertNoErrors();
  });

  test("an update mutes against the record's own id", async () => {
    const rec = { id: "r1", updated: "T0", body: "stored", tags: [] };
    const pane = await makePane({ matches: [match("a")], record: rec });

    await pane.save(false);
    button(pane.calls.layers[0].el, "save anyway").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(pane.calls.update, 1, "an update stays an update — it must not fork into a copy");
    assert.deepEqual(pane.calls.ignorePair, [["r1", "a"]]);
    env.assertNoErrors();
  });

  test("a mute that fails still leaves the record saved, and says so once", async () => {
    const pane = await makePane({ matches: [match("a"), match("b")], ignoreFails: true });
    await pane.save(false);

    button(pane.calls.layers[0].el, "save anyway").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(pane.calls.create, 1, "the write already happened; muting is best effort");
    const complaints = pane.calls.toasts.filter((t) => /could not be muted/.test(t));
    assert.equal(complaints.length, 1, "one honest toast, not one per pair");
    assert.match(complaints[0], /2 of 2/);
    env.assertNoErrors();
  });
});

describe("keep both", () => {
  test("mutes only the row it sits on", async () => {
    const pane = await makePane({ matches: [match("a"), match("b")] });
    await pane.save(false);
    const dlg = pane.calls.layers[0];

    // Two rows, so two "keep both" buttons — take the first one's.
    const rows = [...dlg.el.querySelectorAll(".pl-dupe")];
    assert.equal(rows.length, 2);
    button(rows[0], "keep both").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(pane.calls.ignorePair, [["new1", "a"]], "b is left flagged");
    assert.equal(pane.calls.create, 1);
    env.assertNoErrors();
  });
});
