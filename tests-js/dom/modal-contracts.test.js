import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
const M = "prompt_librarian/prompt_modal/";
let env;
beforeEach(() => { env = setupDom(); });
afterEach(() => { env.assertNoErrors(); env.teardown(); });

test("the new public entry preserves its exports and cache-busted singleton/context identity", async () => {
  const api = await imp(M + "index.js");
  assert.deepEqual(Object.keys(api).sort(), [
    "openModal", "setHost", "attemptClose", "closeModal", "isDirty", "getState", "setState", "subscribe",
    "popLayer", "pushLayer", "toast", "topLayer", "confirmDialog", "ctx", "refreshAll", "getTargetNodeId",
    "loadIntoNode", "isLinked", "pushToNode", "setLinked",
  ].sort());
  const context = api.ctx(), state = api.getState();
  context.requestSave = async () => "clean";
  const fresh = await imp(M + "context.js", { fresh: true });
  const freshState = await imp(M + "state.js", { fresh: true });
  assert.equal(fresh.ctx(), context); assert.equal(freshState.getState(), state);
  const { buildShell } = await imp(M + "shell/layout.js"); const it = buildShell();
  assert.equal(context.els, it.els); assert.equal(context.root, it.root);
  assert.equal(window.__PROMPT_LIBRARIAN__.modal, it);
  assert.equal(await context.requestSave(), "clean");
});

test("state notifies equal references, deduplicates multi-key callbacks and honors silent/unsubscribe", async () => {
  const { getState, setState, subscribe } = await imp(M + "state.js");
  const calls = []; const listener = (state) => calls.push(state);
  const offA = subscribe("selection", listener), offB = subscribe("currentId", listener);
  const offStar = subscribe("*", listener);
  const selection = getState().selection; selection.add("fixture");
  setState({ selection, currentId: "fixture" });
  assert.deepEqual(calls, [getState()]);
  setState({ selection }); assert.equal(calls.length, 2);
  setState({ currentId: "silent" }, { silent: true }); assert.equal(calls.length, 2);
  offA(); offB(); offStar(); setState({ selection }); assert.equal(calls.length, 2);
});

test("draft JSON and link preference keep their existing storage keys and defaults", async () => {
  const draft = await imp(M + "library/drafts.js");
  const prefs = await imp(M + "target/preferences.js");
  const buffer = { body: "synthetic prompt", tags: ["fixture"] };
  draft.saveDraft(null, buffer); assert.equal(sessionStorage.getItem("pl:draft:new"), JSON.stringify(buffer));
  assert.deepEqual(draft.loadDraft(null), buffer); draft.clearDraft(null);
  assert.equal(draft.loadDraft(null), null);
  assert.equal(prefs.readLinkPref(), true); prefs.writeLinkPref(false);
  assert.equal(localStorage.getItem("pl:link"), "0"); assert.equal(prefs.readLinkPref(), false);
  const state = await imp(M + "state.js"); assert.equal(state.freshState().link, false);
});
