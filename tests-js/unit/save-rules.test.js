/* ==========================================================================
   features/inspector/save/rules.js — the save decisions, as pure functions.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const R = await imp("prompt_librarian/features/inspector/save/rules.js");

test("preflight: busy first, then unchanged records, then empty bodies", () => {
  assert.deepEqual(R.preflight({ saving: true }), { status: "busy" });
  assert.equal(R.preflight({ dirty: false, hasRecord: true, body: "x" }).status, "clean");
  assert.equal(R.preflight({ dirty: true, body: "   " }).status, "blocked");
  assert.equal(R.preflight({ dirty: false, hasRecord: false, body: "x" }), null, "a new prompt is never clean");
});

test("isUpdateSave needs both an Update click and a saved record", () => {
  assert.equal(R.isUpdateSave(false, { id: "a" }), true);
  assert.equal(R.isUpdateSave(true, { id: "a" }), false);
  assert.equal(R.isUpdateSave(false, null), false);
});

test("classifyMatches ignores muted pairs and, on update, the record itself", () => {
  const m = (id, score, ignored = false) => ({ id, score, ignored });
  const found = [m("a", 1), m("b", 0.95), m("c", 1, true), m("d", 0.5)];
  assert.deepEqual(R.classifyMatches(found, { threshold: 0.9, isUpdate: false, curId: "a" }), { near: 2, exact: found[0] });
  assert.deepEqual(R.classifyMatches(found, { threshold: 0.9, isUpdate: true, curId: "a" }), { near: 1, exact: null });
});

test("exactAction: commit, update the current record, or adopt the copy", () => {
  assert.equal(R.exactAction({ exact: null }), "commit");
  assert.equal(R.exactAction({ exact: { id: "a" }, isUpdate: true }), "commit");
  assert.equal(R.exactAction({ exact: { id: "a" }, curId: "a" }), "update-current");
  assert.equal(R.exactAction({ exact: { id: "b" }, curId: "a" }), "adopt");
});

test("sameContent compares body (trimmed) and tags (any order)", () => {
  const rec = { body: " fox ", tags: ["b", "a"] };
  assert.equal(R.sameContent(rec, { body: "fox", tags: ["a", "b"] }), true);
  assert.equal(R.sameContent(rec, { body: "fox", tags: ["a"] }), false);
  assert.equal(R.sameContent(null, { body: "fox" }), false);
});

test("expectUpdatedFor prefers an explicit stamp, else the baseline's", () => {
  assert.equal(R.expectUpdatedFor({ updated: "T0" }), "T0");
  assert.equal(R.expectUpdatedFor({ updated: "T0" }, { expectUpdated: "T9" }), "T9");
  assert.equal(R.expectUpdatedFor(null), undefined);
});

test("nearMessage counts in the singular and plural", () => {
  assert.match(R.nearMessage(1), /1 near match,/);
  assert.match(R.nearMessage(3), /3 near matches,/);
});
