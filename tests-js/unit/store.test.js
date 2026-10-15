/* ==========================================================================
   shared/store.js — slices, replace-only sets, change-only notifications.
   ========================================================================== */

import { test } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const { Store } = await imp("prompt_librarian/shared/store.js");

const make = () => new Store({ browse: { query: "", hits: [] }, dupes: { threshold: 0.9 } });

test("a slice reads and replaces its own values", () => {
  const browse = make().slice("browse");
  browse.set({ query: "fox" });
  assert.equal(browse.get("query"), "fox");
  assert.deepEqual(browse.get(), { query: "fox", hits: [] });
});

test("slices are separate: one slice cannot see or write another's keys", () => {
  const store = make();
  const browse = store.slice("browse");
  assert.equal(browse.get("threshold"), undefined);
  assert.throws(() => browse.set({ threshold: 0.5 }), /unknown key "threshold" in slice browse/);
  assert.equal(store.slice("dupes").get("threshold"), 0.9);
});

test("unknown slices and keys throw instead of growing the state", () => {
  const store = make();
  assert.throws(() => store.slice("nope"), /unknown store slice: nope/);
  assert.throws(() => store.slice("browse").subscribe("qeury", () => {}), /unknown key/);
});

test("the snapshot is frozen, so in-place mutation fails loudly", () => {
  const browse = make().slice("browse");
  assert.throws(() => { browse.get().query = "x"; }, TypeError);
});

test("subscribers fire once per changed key, with the new value", () => {
  const browse = make().slice("browse");
  const seen = [];
  browse.subscribe("query", (v, k) => seen.push([k, v]));
  browse.set({ query: "a" });
  browse.set({ query: "a" });
  browse.set({ hits: [1] });
  assert.deepEqual(seen, [["query", "a"]], "equal values and other keys stay quiet");
});

test("a replaced value notifies even when it looks the same", () => {
  const browse = make().slice("browse");
  let calls = 0;
  browse.subscribe("hits", () => calls++);
  browse.set({ hits: [] });
  assert.equal(calls, 1, "a new array is a new value");
});

test("'*' sees every change in the slice once per set", () => {
  const browse = make().slice("browse");
  const seen = [];
  browse.subscribe("*", (state) => seen.push(state.query));
  browse.set({ query: "a", hits: [1] });
  assert.deepEqual(seen, ["a"]);
});

test("unsubscribe stops delivery; a throwing subscriber does not stop the rest", () => {
  const browse = make().slice("browse");
  const errors = [];
  const real = console.error;
  console.error = (...a) => errors.push(a);
  try {
    const seen = [];
    browse.subscribe("query", () => { throw new Error("boom"); });
    const off = browse.subscribe("query", (v) => seen.push(v));
    browse.set({ query: "a" });
    off();
    browse.set({ query: "b" });
    assert.deepEqual(seen, ["a"]);
    assert.equal(errors.length, 2);
  } finally {
    console.error = real;
  }
});

test("listenerCount tracks subscribe and unsubscribe across slices", () => {
  const store = make();
  const off = store.slice("browse").subscribe("query", () => {});
  store.slice("dupes").subscribe("*", () => {});
  assert.equal(store.listenerCount(), 2);
  off();
  assert.equal(store.listenerCount(), 1);
});
