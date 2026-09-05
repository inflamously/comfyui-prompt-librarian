/* ==========================================================================
   Loading the prompt that is already loaded

   Double-clicking a row twice used to write the same text into the node twice
   and, worse, POST a usage ping each time — so re-opening the prompt you were
   already editing inflated its usage count without changing anything.

   loadIntoNode() now compares against the node's LIVE widget state, which is
   the part worth pinning: a remembered "last loaded" value would wrongly skip
   the write after the user edited the textarea on the canvas.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const M = "prompt_librarian/modal/";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.assertNoErrors();
  env.teardown();
});

/** A PromptLibrarian node with the two widgets loadIntoNode touches. */
function fakeNode({ id = 1, body = "", promptId = "" } = {}) {
  return {
    id,
    comfyClass: "PromptLibrarian",
    type: "PromptLibrarian",
    widgets: [
      { name: "text", value: body },
      { name: "prompt_id", value: promptId },
    ],
    setDirtyCanvas() {},
  };
}

async function setup(node) {
  const state = await imp(M + "state.js");
  const target = await imp(M + "target/load.js");
  const host = await imp(M + "target/host.js");
  host.setHost({ app: env.app });
  env.app.graph = {
    _nodes: [node],
    getNodeById: (nid) => (String(nid) === String(node.id) ? node : null),
  };
  state.inst().state.targetNodeId = node.id;
  return target;
}

/** Usage pings are the only POST the load path makes. */
function usageCalls() {
  return env.api.calls.filter((c) => c.method === "POST" && /usage/.test(c.path));
}

describe("pushToNode — the sidebar-selection path", () => {
  test("a record push counts usage once, and a re-push counts nothing", async () => {
    const node = fakeNode();
    await setup(node);
    const binding = await imp(M + "target/binding.js");
    env.api.route("/prompt_librarian/usage", { ok: true });

    const first = binding.pushToNode("a cat", "abc");
    assert.equal(first.ok, true);
    assert.notEqual(first.unchanged, true);

    const second = binding.pushToNode("a cat", "abc");
    assert.equal(second.unchanged, true);

    await new Promise((r) => setTimeout(r, 0));
    assert.equal(usageCalls().length, 1);
  });

  test("a plain keystroke push never counts usage", async () => {
    const node = fakeNode();
    await setup(node);
    const binding = await imp(M + "target/binding.js");
    env.api.route("/prompt_librarian/usage", { ok: true });

    binding.pushToNode("typed text");

    await new Promise((r) => setTimeout(r, 0));
    assert.equal(usageCalls().length, 0);
    assert.equal(node.widgets[0].value, "typed text");
  });

  test("selecting then pressing Enter on the same row counts once", async () => {
    const node = fakeNode();
    const target = await setup(node);
    const binding = await imp(M + "target/binding.js");
    env.api.route("/prompt_librarian/usage", { ok: true });

    binding.pushToNode("a cat", "abc"); // the row click
    const res = target.loadIntoNode({ id: "abc", body: "a cat" }); // Enter on it

    assert.equal(res.unchanged, true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(usageCalls().length, 1);
  });
});

describe("loadIntoNode idempotence", () => {
  test("loading the same record twice writes and pings only once", async () => {
    const node = fakeNode();
    const target = await setup(node);
    env.api.route("/prompt_librarian/usage", { ok: true });

    const first = target.loadIntoNode({ id: "abc", body: "a cat" });
    assert.equal(first.ok, true);
    assert.notEqual(first.unchanged, true);

    const second = target.loadIntoNode({ id: "abc", body: "a cat" });
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);

    await new Promise((r) => setTimeout(r, 0));
    assert.equal(usageCalls().length, 1);
  });

  test("a different body under the same id still loads", async () => {
    const node = fakeNode();
    const target = await setup(node);
    env.api.route("/prompt_librarian/usage", { ok: true });

    target.loadIntoNode({ id: "abc", body: "a cat" });
    const res = target.loadIntoNode({ id: "abc", body: "a dog" });

    assert.equal(res.unchanged, undefined);
    assert.equal(node.widgets[0].value, "a dog");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(usageCalls().length, 2);
  });

  test("editing the node on the canvas makes a re-load a real load", async () => {
    const node = fakeNode();
    const target = await setup(node);
    env.api.route("/prompt_librarian/usage", { ok: true });

    target.loadIntoNode({ id: "abc", body: "a cat" });
    node.widgets[0].value = "a cat, edited"; // the user types on the canvas

    const res = target.loadIntoNode({ id: "abc", body: "a cat" });
    assert.equal(res.unchanged, undefined);
    assert.equal(node.widgets[0].value, "a cat");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(usageCalls().length, 2);
  });
});
