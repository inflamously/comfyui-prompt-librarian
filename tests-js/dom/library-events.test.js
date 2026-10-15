/* The backend broadcasts `prompt_librarian.changed` after every write. A second
 * browser tab must pick those up: the open panel reloads, node faces repaint.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { flush } from "../harness/modal.js";

const M = "prompt_librarian/modal/";
const CHANGED = "prompt_librarian.changed";
let env, modal, it, refreshes;

const linked = (id, pid) => ({
  id, comfyClass: "PromptLibrarian", title: `Node ${id}`,
  widgets: [{ name: "text", value: "body" }, { name: "prompt_id", value: pid }],
  setDirtyCanvas() {},
});

beforeEach(async () => {
  env = setupDom();
  modal = await imp(M + "index.js");
  modal.setHost({ app: env.app });
  it = (await imp(M + "instance.js")).inst();
  refreshes = [];
  it.paneMounters = {
    list(el) {
      el.innerHTML = '<input class="pl-search-in">';
      return { refresh: async (opts) => { refreshes.push(opts); } };
    },
    inspector: () => ({}),
  };
  env.api.route("/prompt_librarian/ping", { rev: 4, threshold: 90 });
  env.api.route("/prompt_librarian/taxonomy", { tags: [], total: 3, rev: 4 });
});

afterEach(() => {
  modal.closeModal();
  env.assertNoErrors();
  env.teardown();
});

test("a write from another tab reloads the open list and taxonomy", async () => {
  await modal.openModal();
  const taxonomies = env.api.callsTo("/taxonomy").length;
  env.api.emit(CHANGED, { op: "create", ids: ["p1"], rev: 5 });
  await flush();
  assert.equal(refreshes.length, 2);
  assert.equal(env.api.callsTo("/taxonomy").length, taxonomies + 1);
});

test("a revision the panel already has is not reloaded again", async () => {
  await modal.openModal();
  env.api.emit(CHANGED, { op: "update", ids: ["p1"], rev: 4 });
  await flush();
  assert.equal(refreshes.length, 1);
});

test("a counted use advances the revision without resetting the list", async () => {
  await modal.openModal();
  env.api.emit(CHANGED, { op: "usage", ids: ["p1"], rev: 9 });
  await flush();
  assert.equal(refreshes.length, 1);
  assert.equal(it.store.slice("library").get("rev"), 9);
});

test("closing the panel stops listening; reopening listens once", async () => {
  const base = env.api.listening(CHANGED);
  await modal.openModal();
  assert.equal(env.api.listening(CHANGED), base + 1);
  modal.closeModal();
  assert.equal(env.api.listening(CHANGED), base);
  await modal.openModal();
  assert.equal(env.api.listening(CHANGED), base + 1);
});

test("node faces linked to a changed id refetch their metadata; others do not", async () => {
  const live = await imp("prompt_librarian/modal/node/live-meta.js");
  const metas = [];
  env.api.route("/prompt_librarian/meta", ({ body }) => {
    metas.push(body.ids);
    return { meta: { p1: { label: "fresh", rating: 3, used: 7 } } };
  });
  const a = linked(1, "p1");
  const b = linked(2, "p2");
  a.__plFace = { tier: 1, head: {}, body: {} };
  env.app.graph._nodes = [a, b];
  live.followLibrary(env.app);
  live.followLibrary(env.app);
  assert.equal(env.api.listening(CHANGED), 1);

  env.api.emit(CHANGED, { op: "rate", ids: ["p1"], rev: 2 });
  await flush(10);
  assert.deepEqual(metas, [["p1"]]);
  assert.equal(a.__plMeta.used, 7);
  assert.equal(b.__plMeta, undefined);
});
