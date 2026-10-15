import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
const M = "prompt_librarian/modal/";
let env;
beforeEach(() => { env = setupDom(); });
afterEach(() => { env.assertNoErrors(); env.teardown(); });

test("the public entry keeps its exports, and cache-busted copies share one instance and Store", async () => {
  const api = await imp(M + "index.js");
  assert.deepEqual(Object.keys(api).sort(), [
    "openModal", "setHost", "attemptClose", "closeModal", "isDirty", "refreshAll", "getTargetNodeId",
    "loadIntoNode", "isLinked", "pushToNode", "setLinked",
  ].sort());
  const { inst } = await imp(M + "instance.js");
  const it = inst(), store = it.store;
  const freshInstance = await imp(M + "instance.js", { fresh: true });
  assert.equal(freshInstance.inst(), it); assert.equal(freshInstance.inst().store, store);
  const { buildShell } = await imp(M + "shell/layout.js", { fresh: true });
  assert.equal(buildShell(), it);
  assert.equal(window.__PROMPT_LIBRARIAN__.modal, it);
});

test("draft JSON and link preference keep their existing storage keys and defaults", async () => {
  const draft = await imp(M + "drafts.js");
  const prefs = await imp(M + "target/preferences.js");
  const buffer = { body: "synthetic prompt", tags: ["fixture"] };
  draft.saveDraft(null, buffer); assert.equal(sessionStorage.getItem("pl:draft:new"), JSON.stringify(buffer));
  assert.deepEqual(draft.loadDraft(null), buffer); draft.clearDraft(null);
  assert.equal(draft.loadDraft(null), null);
  assert.equal(prefs.readLinkPref(), true); prefs.writeLinkPref(false);
  assert.equal(localStorage.getItem("pl:link"), "0"); assert.equal(prefs.readLinkPref(), false);
  const { initialState } = await imp(M + "instance.js"); assert.equal(initialState().shell.link, false);
});
