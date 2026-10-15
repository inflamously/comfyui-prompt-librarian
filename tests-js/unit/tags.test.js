/* ==========================================================================
   features/tags/normalize.js — the client copy of the backend's tag rules.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const { normalizeTag, taxonomyRows, MAX_TAGS } = await imp("prompt_librarian/features/tags/index.js");

test("normalizeTag trims, hyphenates whitespace, lowercases and caps at 40", () => {
  assert.equal(normalizeTag("  Camera   Move "), "camera-move");
  assert.equal(normalizeTag(null), "");
  assert.equal(normalizeTag("x".repeat(50)).length, 40);
  assert.equal(MAX_TAGS, 32);
});

test("taxonomyRows accepts both server shapes and drops empty names", () => {
  assert.deepEqual(taxonomyRows([{ name: "a", count: "3" }, "b", null, { name: "" }, ""]), [
    { name: "a", count: 3 },
    { name: "b", count: 0 },
  ]);
  assert.deepEqual(taxonomyRows(undefined), []);
});
