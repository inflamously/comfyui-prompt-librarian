/* ==========================================================================
   features/browse/selection.js on the real Store

   The Store only notifies on a new value, so every selection change must
   replace the Set. The rail's checkboxes repaint from that notification; a
   mutated-in-place Set would leave them stale with no error anywhere.
   ========================================================================== */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

let env;
beforeEach(() => { env = setupDom(); });
afterEach(() => { env.assertNoErrors(); env.teardown(); });

async function setup() {
  delete window.__PROMPT_LIBRARIAN__;
  const { slice } = await imp("prompt_librarian/modal/instance.js");
  const { createSelection } = await imp("prompt_librarian/features/browse/selection.js");
  const rows = ["a", "b", "c"].map((id) => ({ id, body: id }));
  const source = {
    total: rows.length,
    peek: (i) => rows[i],
    idsInRange: async (from, to) => rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((r) => r.id),
  };
  const browse = slice("browse");
  const seen = [];
  browse.subscribe("selection", (value) => seen.push([...value].sort()));
  return { browse, seen, selection: createSelection({ slice: browse, source }) };
}

test("every change publishes a new Set and leaves the old one untouched", async () => {
  const { browse, seen, selection } = await setup();
  const first = browse.get("selection");
  selection.toggleId("a", true);
  selection.toggleId("b", true);
  selection.toggleId("a", false);
  assert.deepEqual(seen, [["a"], ["a", "b"], ["b"]]);
  assert.equal(first.size, 0, "the initial Set was never mutated");
});

test("a range, select-all-filtered and clear each notify", async () => {
  const { browse, seen, selection } = await setup();
  await selection.selectRange(0);
  await selection.selectRange(2);
  assert.deepEqual(seen.at(-1), ["a", "b", "c"]);
  selection.selectAllFiltered();
  assert.equal(browse.get("selectionMode"), "filter");
  selection.toggleId("b", true);
  assert.deepEqual(seen.at(-1), ["b"], "leaving filter mode starts from an empty Set");
  selection.clear();
  assert.deepEqual(seen.at(-1), []);
  assert.equal(seen.length, 5);
});
