/* ==========================================================================
   The panel is a signal; `revise` is the workbench

   The inline panel used to list every match, which made a routine near-miss
   look like a wall of decisions inside the editor. It now keeps one row — the
   closest — and puts the count and the threshold in its heading. Everything
   else lives behind `revise`, one dialog that lists them all with the same
   actions.
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

function match(id, over = {}) {
  return { id, label: id + "_label", score: 0.97, summary: "a word", ignored: false, ...over };
}

async function makePanel(matches) {
  const { resolveHelpers } = await imp(I + "helpers.js");
  const { buildView } = await imp(I + "view.js");
  const { createDupes } = await imp(I + "dupes.js");

  const calls = { layers: [], settings: [], refreshed: 0, compared: [], toasts: [] };
  const ctx = {
    ABORTED: Symbol("aborted"),
    API: {
      dupes: async () => ({ ok: true, matches }),
      ignorePair: async () => ({ ok: true }),
      settings: async (patch) => { calls.settings.push(patch); return { ok: true }; },
    },
    list: { refresh: () => { calls.refreshed++; } },
    setState: (patch) => Object.assign(state, patch),
  };
  const state = { dupes: { threshold: 0.9, matches, loading: false } };

  const el = document.createElement("div");
  document.body.appendChild(el);
  const pane = {
    ctx,
    el,
    calls,
    D: resolveHelpers(ctx),
    S: () => state,
    buf: { tags: [], body: "a body long enough to be checked at all" },
    current: { id: "mine" },
    disposed: false,
    dupeSeq: 0,
    dupePaused: false,
    lane: (_name, run) => run(null),
    toast: (m) => calls.toasts.push(String(m)),
    compareWith: (m) => calls.compared.push(m.id),
    mergeInto() {},
    openLayer(node) {
      const layer = { el: node, closed: false, close: () => { layer.closed = true; } };
      calls.layers.push(layer);
      return layer;
    },
    openLocalPopover(_anchor, _opts, onPick) { pane.pick = onPick; },
  };
  pane.els = buildView(pane).els;
  createDupes(pane);
  pane.renderDupes();
  return pane;
}

const rows = (node) => [...node.querySelectorAll(".pl-dupe")];

describe("the inline panel", () => {
  test("is a heading and nothing else — no match is listed inline", async () => {
    const pane = await makePanel([match("a"), match("b"), match("c")]);

    assert.equal(rows(pane.els.dupesBody).length, 0);
    assert.equal(pane.els.dupesBody.textContent, "", "the body stays empty");
    assert.doesNotMatch(pane.els.dupesPanel.textContent, /a_label/, "not even the closest one");
    assert.match(pane.els.dupesTitle.textContent, /3 near matches/, "the count is in the heading");
    env.assertNoErrors();
  });

  test("`revise` appears only when there is something to revise", async () => {
    const withMatches = await makePanel([match("a")]);
    assert.equal(withMatches.els.reviseBtn.hidden, false);

    const clean = await makePanel([]);
    assert.equal(clean.els.reviseBtn.hidden, true);
    env.assertNoErrors();
  });
});

describe("the revise dialog", () => {
  test("lists every match, not just the one on the panel", async () => {
    const pane = await makePanel([match("a"), match("b"), match("c")]);
    pane.els.reviseBtn.click();

    const dlg = pane.calls.layers[0];
    assert.ok(dlg, "a dialog opened");
    assert.equal(rows(dlg.el).length, 3);
    assert.match(dlg.el.textContent, /c_label/);
    env.assertNoErrors();
  });

  test("each row says what survives and what is thrown away", async () => {
    const pane = await makePanel([match("a")]);
    pane.els.reviseBtn.click();
    const row = rows(pane.calls.layers[0].el)[0];

    assert.match(row.textContent, /merge keeps .*a_label.* \(id, usage, history\)/);
    assert.match(row.textContent, /throws away/, "the cost of merging is named, not implied");
    assert.match(row.textContent, /overwrite keeps both records/);
    env.assertNoErrors();
  });

  test("an unsaved draft has nothing to throw away, and does not claim it does", async () => {
    const pane = await makePanel([match("a")]);
    pane.current = null;
    pane.els.reviseBtn.click();
    const row = rows(pane.calls.layers[0].el)[0];

    const mergeLine = [...row.querySelectorAll(".pl-dupe-why")].find((n) => /^merge keeps/.test(n.textContent));
    assert.match(mergeLine.textContent, /nothing else is created/);
    assert.doesNotMatch(mergeLine.textContent, /throws away/);
    env.assertNoErrors();
  });

  test("acting on a row closes the dialog it was launched from", async () => {
    const pane = await makePanel([match("a"), match("b")]);
    pane.els.reviseBtn.click();
    const dlg = pane.calls.layers[0];

    [...dlg.el.querySelectorAll("button")].find((b) => b.textContent === "compare").click();

    assert.deepEqual(pane.calls.compared, ["a"]);
    assert.equal(dlg.closed, true, "compare takes the screen; this must not stay under it");
    env.assertNoErrors();
  });
});

describe("the threshold", () => {
  test("is persisted and the list is re-asked, not just this panel", async () => {
    const pane = await makePanel([match("a")]);
    pane.els.threshBtn.click();
    pane.pick(0.8);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(pane.S().dupes.threshold, 0.8, "the panel uses it now");
    assert.match(pane.els.threshBtn.textContent, /80%/);
    assert.deepEqual(pane.calls.settings, [{ dupe_threshold: 0.8 }], "and it survives a reopen");
    assert.ok(pane.calls.refreshed > 0, "the list's duplicate counts agree with the panel");
    env.assertNoErrors();
  });
});
