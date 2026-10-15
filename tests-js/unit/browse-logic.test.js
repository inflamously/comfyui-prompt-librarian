/* ==========================================================================
   features/browse pure modules: key movement and search parameters.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const { targetIndex } = await imp("prompt_librarian/features/browse/list-keys.js");
const { searchParams } = await imp("prompt_librarian/features/browse/search-params.js");

test("arrows step and clamp; with nothing active they start at the ends", () => {
  assert.equal(targetIndex("ArrowDown", -1, 10, 5), 0);
  assert.equal(targetIndex("ArrowUp", -1, 10, 5), 0);
  assert.equal(targetIndex("ArrowDown", 9, 10, 5), 9);
  assert.equal(targetIndex("ArrowUp", 0, 10, 5), 0);
});

test("Home, End and the page keys", () => {
  assert.deepEqual(["Home", "End", "PageDown", "PageUp"].map((k) => targetIndex(k, 4, 10, 5)), [0, 9, 9, 0]);
  assert.equal(targetIndex("PageDown", -1, 10, 3), 3, "a page from the top");
});

test("other keys, and an empty list, do not move", () => {
  assert.equal(targetIndex("Enter", 2, 10, 5), null);
  assert.equal(targetIndex("ArrowDown", 0, 0, 5), null);
});

test("searchParams sends nulls for unused filters and the match context", () => {
  const query = { q: "", tags: [], dupesOnly: false, sort: "" };
  assert.deepEqual(searchParams(query, { threshold: 0.9, currentId: null }, 0, 200), {
    q: "", tags: null, dupes_only: null, group: true, sort: "relevance",
    offset: 0, limit: 200, threshold: 0.9, match_id: null,
  });
  const p = searchParams({ q: "fox", tags: ["a"], dupesOnly: true, sort: "az" }, { currentId: "x" }, 200, 200);
  assert.deepEqual([p.q, p.tags, p.dupes_only, p.sort, p.match_id], ["fox", ["a"], true, "az", "x"]);
});
