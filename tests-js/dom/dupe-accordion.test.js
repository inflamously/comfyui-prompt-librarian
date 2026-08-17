/* ==========================================================================
   The duplicate accordion, from a /search payload to rows on screen

   The complaint this feature answers: a library holding four copies of one
   prompt showed four rows, each badged "1 near-dupe" — a number that matched
   nothing the user could see, because muted pairs had been subtracted from it.
   It is now ONE row badged "4 copies" that opens into the four.

   Two tiers here. `updateRow` on its own, because the three row kinds (header,
   member, plain) are pure rendering; then the real rail against a stubbed
   /search, because the interesting part — a click changing how many rows the
   virtual list believes in — spans four modules.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const B = "prompt_librarian/browse/";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

const STATE = { currentId: null, selection: new Set(), selectionMode: "ids" };

function hit(id, over = {}) {
  return {
    id,
    label: id + " label",
    preview: "a dancer in the rain",
    tags: [],
    rating: 0,
    used: 0,
    last_run: "",
    updated: "2026-03-01T00:00:00Z",
    chars: 20,
    version_count: 0,
    score: 0,
    dupe_count: 0,
    match_pct: null,
    group_size: 1,
    ...over,
  };
}

/* -- tier 1: the three row kinds ----------------------------------------- */

describe("updateRow paints three kinds of row", () => {
  test("a cluster header counts the cluster, not its near-dupes", async () => {
    const { createRow, updateRow } = await imp(B + "rows.js");
    const row = createRow();
    const view = { isMember: () => false, isOpen: () => false };

    updateRow(row, hit("rep", { group_size: 4, dupe_count: 3 }), 0, STATE, view);

    assert.equal(row.__parts.badge.textContent, "4 copies");
    assert.equal(row.__parts.badge.hidden, false);
    assert.equal(row.classList.contains("is-group"), true);
    assert.equal(row.__parts.twisty.hidden, false);
    assert.equal(row.getAttribute("aria-expanded"), "false");
  });

  test("an open header says so, for the twisty and for a screen reader", async () => {
    const { createRow, updateRow } = await imp(B + "rows.js");
    const row = createRow();
    const view = { isMember: () => false, isOpen: () => true };

    updateRow(row, hit("rep", { group_size: 4 }), 0, STATE, view);

    assert.equal(row.getAttribute("aria-expanded"), "true");
    assert.notEqual(row.__parts.twisty.textContent, "");
  });

  test("a member is indented and stays quiet — its header already spoke", async () => {
    const { createRow, updateRow } = await imp(B + "rows.js");
    const row = createRow();
    const view = { isMember: () => true, isOpen: () => true };

    updateRow(row, hit("m1", { dupe_count: 3 }), 2, STATE, view);

    assert.equal(row.classList.contains("is-member"), true);
    assert.equal(row.classList.contains("is-group"), false);
    assert.equal(row.__parts.badge.hidden, true, "no second count inside the group");
    assert.equal(row.__parts.twisty.hidden, true);
  });

  test("an ordinary row keeps the near-dupe badge", async () => {
    const { createRow, updateRow } = await imp(B + "rows.js");
    const row = createRow();
    const view = { isMember: () => false, isOpen: () => false };

    updateRow(row, hit("solo", { dupe_count: 2 }), 0, STATE, view);

    assert.equal(row.__parts.badge.textContent, "2 near-dupes");
    assert.equal(row.__parts.twisty.hidden, true);
  });

  test("no view at all paints flat — the compare dialog reuses this renderer", async () => {
    const { createRow, updateRow } = await imp(B + "rows.js");
    const row = createRow();

    updateRow(row, hit("x", { group_size: 4, dupe_count: 3 }), 0, STATE);

    assert.equal(row.__parts.badge.textContent, "3 near-dupes");
    assert.equal(row.classList.contains("is-group"), false);
  });

  test("a recycled group row painted as a skeleton drops every group marking", async () => {
    const { createRow, updateRow } = await imp(B + "rows.js");
    const row = createRow();
    const view = { isMember: () => false, isOpen: () => false };

    updateRow(row, hit("rep", { group_size: 4 }), 0, STATE, view);
    updateRow(row, null, 0, STATE, view);

    assert.equal(row.classList.contains("is-group"), false);
    assert.equal(row.classList.contains("is-member"), false);
    assert.equal(row.__parts.twisty.hidden, true);
    assert.equal(row.__parts.badge.hidden, true);
  });
});

/* -- tier 2: the rail ----------------------------------------------------- */

/** Four copies of one prompt folded into one row, plus one unrelated record. */
const GROUPED_PAYLOAD = {
  rev: 1,
  total: 2,
  record_total: 5,
  offset: 0,
  limit: 200,
  threshold: 0.9,
  took_ms: 1,
  dupes_partial: false,
  fallback: false,
  hits: [
    hit("d4", { group_size: 4, dupe_count: 3 }),
    hit("fruit", { preview: "a bowl of fruit" }),
  ],
  groups: {
    d4: [hit("d3", { dupe_count: 3 }), hit("d2", { dupe_count: 3 }), hit("d1", { dupe_count: 3 })],
  },
};

/**
 * Mount the real rail against a stubbed /search.
 *
 * The rail reaches for a dozen ctx hooks; all but `API` are inert here, which
 * is the point — what is under test is index mapping and row counts, not the
 * inspector it would otherwise talk to.
 */
async function mountRail(payload = GROUPED_PAYLOAD) {
  const { mountList } = await imp(B + "index.js");
  const { API } = await imp("prompt_librarian/api/routes.js");

  env.api.route("/prompt_librarian/taxonomy", { tags: [] });
  env.api.route("/prompt_librarian/search", payload);

  const state = {
    query: { q: "", tags: [], dupesOnly: false, sort: "relevance" },
    selection: new Set(),
    selectionMode: "ids",
    currentId: null,
    tags: [],
    dupes: { threshold: 0.9 },
  };
  const ctx = {
    API,
    debounces: [],
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    subscribe: () => () => {},
    onKey: (el, type, fn) => {
      el.addEventListener(type, fn);
      return () => el.removeEventListener(type, fn);
    },
    selectPrompt: (id) => {
      state.currentId = id;
    },
    loadIntoNode: () => ({ ok: true }),
    toast() {},
    reportError() {},
    confirmDialog: async () => true,
  };

  const el = document.createElement("div");
  document.body.appendChild(el);
  const list = mountList(el, ctx);
  await list.refresh();
  return { list, ctx, state, el };
}

/** The rows the virtual list actually has mounted, in index order. */
function rows(el) {
  return [...el.querySelectorAll(".pl-row")]
    .filter((r) => !r.classList.contains("pl-row-skel"))
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
}

describe("the rail folds duplicate clusters", () => {
  test("asks the backend to group", async () => {
    await mountRail();
    assert.equal(env.api.callsTo("/search")[0].query.group, "true");
    env.assertNoErrors();
  });

  test("four copies are one row until it is opened", async () => {
    const { el } = await mountRail();
    const shown = rows(el);
    assert.equal(shown.length, 2, "the cluster + the bowl of fruit");
    assert.deepEqual(shown.map((r) => r.dataset.id), ["d4", "fruit"]);
    assert.equal(shown[0].__parts.badge.textContent, "4 copies");
    env.assertNoErrors();
  });

  test("the hit count is records, not rows", async () => {
    const { el } = await mountRail();
    assert.equal(el.querySelector(".pl-hits").textContent, "5 hits");
    env.assertNoErrors();
  });

  test("the twisty opens it into its members, in place", async () => {
    const { el } = await mountRail();
    rows(el)[0].__parts.twisty.click();

    const shown = rows(el);
    assert.deepEqual(shown.map((r) => r.dataset.id), ["d4", "d3", "d2", "d1", "fruit"]);
    assert.equal(shown[1].classList.contains("is-member"), true);
    assert.equal(shown[4].classList.contains("is-member"), false, "'fruit' only moved down");
    env.assertNoErrors();
  });

  test("and closes it again", async () => {
    const { el } = await mountRail();
    rows(el)[0].__parts.twisty.click();
    rows(el)[0].__parts.twisty.click();
    assert.deepEqual(rows(el).map((r) => r.dataset.id), ["d4", "fruit"]);
    env.assertNoErrors();
  });

  test("clicking the header selects the record AND opens the cluster", async () => {
    // You asked about a prompt the library has four of; the other three are
    // the answer to the question you just asked.
    const { el, state } = await mountRail();
    rows(el)[0].click();
    assert.equal(state.currentId, "d4");
    assert.equal(rows(el).length, 5);
    env.assertNoErrors();
  });

  test("clicking an already-open header does not close it under the user", async () => {
    const { el } = await mountRail();
    rows(el)[0].__parts.twisty.click();
    rows(el)[0].click();
    assert.equal(rows(el).length, 5, "still open");
    env.assertNoErrors();
  });
});

describe("selecting a folded cluster", () => {
  test("ticking a collapsed cluster ticks every prompt in it", async () => {
    const { el, state } = await mountRail();
    const box = rows(el)[0].__parts.check;
    box.checked = true;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));

    assert.deepEqual([...state.selection].sort(), ["d1", "d2", "d3", "d4"]);
    env.assertNoErrors();
  });

  test("open it and a member ticks only itself", async () => {
    const { el, state } = await mountRail();
    rows(el)[0].__parts.twisty.click();
    const box = rows(el)[2].__parts.check; // d2
    box.checked = true;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));

    assert.deepEqual([...state.selection], ["d2"]);
    env.assertNoErrors();
  });

  test("un-ticking a collapsed cluster releases the whole cluster", async () => {
    const { el, state } = await mountRail();
    const box = rows(el)[0].__parts.check;
    box.checked = true;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
    box.checked = false;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));

    assert.deepEqual([...state.selection], []);
    env.assertNoErrors();
  });

  test('"all filtered" counts records, so it cannot promise fewer than it deletes', async () => {
    const { list } = await mountRail();
    list.selectAllFiltered();
    assert.equal(list.selection.count(), 5, "not 2, which is the row count");
    env.assertNoErrors();
  });
});
