import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { deferred, flush } from "../harness/modal.js";

const M = "prompt_librarian/prompt_modal/";
let env, modal, state, it, mounts, refreshes, seeds;
const node = (id, body = `node ${id}`) => ({
  id, comfyClass: "PromptLibrarian", title: `Target ${id}`,
  widgets: [{ name: "text", value: body }, { name: "prompt_id", value: "" }],
  setDirtyCanvas() {},
});
beforeEach(async () => {
  env = setupDom();
  modal = await imp(M + "index.js");
  state = await imp(M + "state.js");
  modal.setHost({ app: env.app });
  it = state.inst();
  mounts = []; refreshes = []; seeds = [];
  env.app.graph._nodes = [node(1), node(2)];
  it.paneLoads = {
    list: Promise.resolve({ mountList(el, ctx) {
      mounts.push("list");
      el.innerHTML = '<input class="pl-search-in">';
      ctx.list = { refresh: async (opts) => { refreshes.push(opts); } };
    } }),
    inspector: Promise.resolve({ mountInspector(el, ctx) {
      mounts.push("inspector");
      ctx.inspector = { setBody(body) { seeds.push(body); ctx.setState({ buffer: { body, tags: [] } }); } };
    } }),
  };
  env.api.route("/prompt_librarian/taxonomy", { tags: ["synthetic"], total: 3 });
});
afterEach(() => {
  modal.closeModal();
  mock.restoreAll();
  env.assertNoErrors();
  env.teardown();
});

function ping(value = { rev: 1, threshold: 90 }) {
  env.api.route("/prompt_librarian/ping", value);
}

test("concurrent opens share initialization and seed only the latest target", async () => {
  const held = deferred(); ping(() => held.promise);
  const first = modal.openModal({ targetNodeId: 1 });
  const second = modal.openModal({ targetNodeId: 2 });
  assert.equal(it.state.targetNodeId, 2);
  assert.match(it.els.target.textContent, /#2 Target 2/);
  assert.equal(env.api.callsTo("/ping").length, 1);
  held.resolve({ rev: 7, threshold: 85 });
  assert.equal(await first, await second);
  assert.deepEqual(mounts.sort(), ["inspector", "list"]);
  assert.equal(refreshes.length, 1);
  assert.deepEqual(seeds, ["node 2"]);
  assert.equal(it.state.dupes.threshold, .85);
  assert.equal(document.activeElement, it.root.querySelector(".pl-search-in"));
});

test("closing during ping prevents taxonomy, pane mounts, rebinding and focus", async () => {
  const held = deferred(); ping(() => held.promise);
  const outside = document.body.appendChild(document.createElement("button")); outside.focus();
  const opening = modal.openModal();
  modal.closeModal();
  held.resolve({ rev: 99 }); await opening;
  assert.equal(env.api.callsTo("/taxonomy").length, 0);
  assert.deepEqual(mounts, []);
  assert.equal(it.binding, null);
  assert.equal(it.state.rev, 0);
  assert.equal(document.activeElement, outside);
  assert.equal(it.root.hidden, true);
});

test("closing during taxonomy ignores its result and never mounts", async () => {
  env.api.reset(); ping();
  const held = deferred();
  env.api.route("/prompt_librarian/taxonomy", () => held.promise);
  const opening = modal.openModal(); await flush();
  assert.equal(env.api.callsTo("/taxonomy").length, 1);
  modal.closeModal(); held.resolve({ tags: ["late"], total: 100 }); await opening;
  assert.deepEqual(it.state.tags, []);
  assert.deepEqual(mounts, []);
});

test("reopening does not wait for an invalidated ping or accept its late state", async () => {
  const old = deferred(); let calls = 0;
  ping(() => ++calls === 1 ? old.promise : { rev: 2 });
  const first = modal.openModal({ targetNodeId: 1 });
  const root = it.root; modal.closeModal();
  await modal.openModal({ targetNodeId: 2 });
  old.resolve({ rev: 99 }); await first;
  assert.equal(it.root, root);
  assert.equal(it.state.rev, 2);
  assert.equal(it.state.targetNodeId, 2);
  assert.equal(refreshes.length, 1);
  assert.deepEqual(seeds, ["node 2"]);
});

test("retargeting an open pane takes effect before pending initialization completes", async () => {
  const held = deferred(); let calls = 0;
  ping(() => ++calls === 1 ? {} : held.promise);
  await modal.openModal({ targetNodeId: 1 });
  const opening = modal.openModal({ targetNodeId: 2 });
  assert.deepEqual(seeds, ["node 1", "node 2"]);
  assert.equal(it.binding.node.id, 2);
  held.resolve({}); await opening;
  assert.equal(mounts.length, 2);
});

test("pending pane imports are shared across reopen and stale mounts are skipped", async () => {
  ping();
  const held = deferred();
  const listModule = await it.paneLoads.list;
  it.paneLoads.list = held.promise;
  const first = modal.openModal(); await flush();
  assert.deepEqual(mounts, ["inspector"], "inspector must not wait for the list import");
  modal.closeModal();
  const second = modal.openModal({ targetNodeId: 2 }); await flush();
  held.resolve(listModule); await Promise.all([first, second]);
  assert.deepEqual(mounts, ["inspector", "list"]);
  assert.equal(refreshes.length, 1);
  assert.equal(it.binding.node.id, 2);
});

test("closing during pane import prevents mounting after it resolves", async () => {
  ping(); const held = deferred();
  const listModule = await it.paneLoads.list; it.paneLoads.list = held.promise;
  const opening = modal.openModal(); await flush(); modal.closeModal();
  held.resolve(listModule); await opening;
  assert.deepEqual(mounts, ["inspector"]);
  assert.equal(refreshes.length, 0);
  assert.equal(it.binding, null);
});

for (const failed of ["list", "inspector"]) {
  test(`${failed} mount failure leaves its sibling usable and retries on reopen`, async () => {
    ping(); const good = await it.paneLoads[failed];
    it.paneLoads[failed] = Promise.resolve({ [failed === "list" ? "mountList" : "mountInspector"]() { throw Error("synthetic mount fault"); } });
    await modal.openModal();
    assert.equal(it.mounted[failed], false);
    assert.equal(it.mounted[failed === "list" ? "inspector" : "list"], true);
    assert.match(it.els[failed === "list" ? "rail" : "inspect"].textContent, /unavailable|not available/);
    modal.closeModal(); it.paneLoads[failed] = Promise.resolve(good);
    await modal.openModal();
    assert.equal(it.mounted[failed], true);
  });
}

test("closing during list refresh does not move focus afterward", async () => {
  ping(); await modal.openModal();
  const held = deferred(); it.ctx.list.refresh = () => held.promise;
  const opening = modal.openModal(); await flush(); modal.closeModal();
  const outside = document.body.appendChild(document.createElement("button")); outside.focus();
  held.resolve(); await opening;
  assert.equal(document.activeElement, outside);
  assert.equal(it.binding, null);
});

test("each opening installs and removes one heartbeat and matching event listeners", async () => {
  ping();
  const intervals = new Set();
  mock.method(globalThis, "setInterval", (fn) => { intervals.add(fn); return fn; });
  mock.method(globalThis, "clearInterval", (id) => intervals.delete(id));
  const add = mock.method(window, "addEventListener");
  const remove = mock.method(window, "removeEventListener");
  await modal.openModal();
  const root = it.root, ctx = modal.ctx();
  const subs = [...it.subs.values()].reduce((n, s) => n + s.size, 0);
  for (let i = 0; i < 2; i++) {
    assert.equal(intervals.size, 1);
    modal.closeModal();
    assert.equal(intervals.size, 0);
    assert.equal(it.teardown.length, 0);
    assert.equal(it.heartbeat, 0);
    for (const { arguments: args } of add.mock.calls.filter(c => ["resize", "keydown", "keyup", "keypress"].includes(c.arguments[0]))) {
      assert.ok(remove.mock.calls.some(c => c.arguments.every((v, j) => v === args[j])));
    }
    await modal.openModal();
    assert.equal(it.root, root); assert.equal(modal.ctx(), ctx);
    assert.equal([...it.subs.values()].reduce((n, s) => n + s.size, 0), subs);
  }
  assert.equal(mounts.length, 2);
  modal.closeModal();
});

test("ResizeObserver disconnects on close and reinstalls on reopen", async () => {
  ping(); const observers = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  try {
    await modal.openModal(); modal.closeModal(); await modal.openModal();
    assert.equal(observers.length, 2); assert.equal(observers[0].disconnected, true);
    assert.equal(observers[1].disconnected, false);
    modal.closeModal(); assert.equal(observers[1].disconnected, true);
  } finally {
    if (original === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = original;
  }
});

test("heartbeat reconciles deletion, replacement and link preference without usage writes", async () => {
  ping(); let heartbeat;
  mock.method(globalThis, "setInterval", (fn) => { heartbeat = fn; return 1; });
  mock.method(globalThis, "clearInterval", () => {});
  await modal.openModal({ targetNodeId: 1 });
  const original = env.app.graph._nodes[0];
  env.app.graph._nodes = []; heartbeat();
  assert.equal(it.binding, null); assert.equal(it.state.targetOk, false);
  assert.match(it.els.target.textContent, /no Librarian node/);
  original.widgets[0].value = "deleted node edit";
  assert.equal(seeds.at(-1), "node 1");
  const replacement = node(1, "replacement"); env.app.graph._nodes = [replacement]; heartbeat();
  assert.equal(it.binding.node, replacement); assert.equal(seeds.at(-1), "replacement");
  it.els.link.click();
  assert.equal(localStorage.getItem("pl:link"), "0"); assert.equal(it.binding, null);
  replacement.widgets[0].value = "unlinked edit"; heartbeat();
  assert.equal(seeds.at(-1), "replacement");
  it.els.link.click();
  assert.equal(localStorage.getItem("pl:link"), "1"); assert.equal(seeds.at(-1), "unlinked edit");
  assert.equal(it.els.link.getAttribute("aria-pressed"), "true");
  assert.equal(env.api.callsTo("/usage").length, 0);
});

test("responsive navigation keeps Browse/Edit selection consistent across widths", async () => {
  ping(); window.innerWidth = 600; await modal.openModal();
  const tabs = it.els.seg.querySelectorAll("button"); tabs[1].click();
  assert.equal(it.els.body.dataset.pane, "edit");
  window.innerWidth = 1200; window.dispatchEvent(new Event("resize"));
  assert.equal(it.root.dataset.w, "wide");
  assert.equal(it.els.body.dataset.pane, "browse");
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].getAttribute("aria-selected"), "false");
});

test("actual optional panes mount, seed from the node, and survive reopening", async () => {
  ping(); it.paneLoads = {};
  env.api.route("/prompt_librarian/search", { hits: [], total: 0 });
  env.api.route("/prompt_librarian/dupes", { matches: [] });
  env.api.route("/prompt_librarian/autocomplete", { items: [] });
  await modal.openModal({ targetNodeId: 1 });
  assert.deepEqual(it.mounted, { list: true, inspector: true });
  assert.equal(it.ctx.inspector.getBuffer().body, "node 1");
  const list = it.ctx.list, inspector = it.ctx.inspector;
  modal.closeModal(); await modal.openModal({ targetNodeId: 2 });
  assert.equal(it.ctx.list, list); assert.equal(it.ctx.inspector, inspector);
  assert.equal(inspector.getBuffer().body, "node 2");
});

test("a pending inspector is seeded even if binding is requested before it mounts", async () => {
  ping(); const held = deferred();
  const inspectorModule = await it.paneLoads.inspector; it.paneLoads.inspector = held.promise;
  const opening = modal.openModal(); await flush();
  const { syncBinding } = await imp(M + "target/binding.js"); syncBinding();
  assert.equal(it.binding, null);
  held.resolve(inspectorModule); await opening;
  assert.deepEqual(seeds, ["node 1"]);
});

test("a failed optional import does not block its sibling", async () => {
  ping(); const held = deferred(); it.paneLoads.list = held.promise;
  const opening = modal.openModal(); await flush();
  held.reject(Error("synthetic import failure")); await opening;
  assert.equal(it.mounted.list, false); assert.equal(it.mounted.inspector, true);
  assert.match(it.els.rail.textContent, /unavailable/);
});

test("a completed save from an old session cannot close a reopened modal", async () => {
  ping(); await modal.openModal(); const held = deferred();
  it.ctx.isDirty = () => true; it.ctx.requestSave = () => held.promise;
  assert.equal(modal.attemptClose(), false); await flush();
  modal.closeModal(); await modal.openModal();
  held.resolve("saved"); await flush();
  assert.equal(it.open, true);
});

test("closing clears both toast expiration and animation timers", async () => {
  ping(); await modal.openModal();
  const timers = new Set();
  mock.method(globalThis, "setTimeout", (fn) => { timers.add(fn); return fn; });
  mock.method(globalThis, "clearTimeout", (fn) => timers.delete(fn));
  const toast = modal.toast("synthetic toast"); toast.click();
  assert.equal(timers.size, 2); modal.closeModal();
  assert.equal(timers.size, 0); assert.equal(it.toastCleanup.size, 0);
  assert.equal(it.els.toasts.children.length, 0);
});
