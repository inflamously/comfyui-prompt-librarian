import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { http } from "../harness/net.js";
import { openShell, deferred, flush } from "../harness/modal.js";

const M = "prompt_librarian/modal/";
let env, shell, actions;
const snapshot = (overrides = {}) => ({
  database_bytes: 2048, records: 4, reclaimable_bytes: 1024, should_compact: true,
  index: { state: "ready", fts5: true },
  legacy: { available: true, sources: ["synthetic-library.json"] }, ...overrides,
});
beforeEach(async () => {
  env = setupDom(); shell = await openShell();
  actions = await imp(M + "storage/actions.js");
  env.api.route("/prompt_librarian/storage", { storage: snapshot() });
  env.api.route("/prompt_librarian/taxonomy", { tags: ["fixture"], total: 5 });
});
afterEach(() => {
  shell.closeModal(); mock.restoreAll();
  env.assertNoErrors(); env.teardown();
});
function button(text, scope = shell.layers.topLayer().el) {
  const found = [...scope.querySelectorAll("button")].find(b => b.textContent === text);
  assert.ok(found, `missing button: ${text}`); return found;
}

test("storage status renders API snapshot and closing removes its subscriptions", async () => {
  const count = () => [...shell.it.subs.values()].reduce((n, s) => n + s.size, 0);
  const before = count(); const handle = await actions.openStorage();
  assert.match(handle.el.textContent, /database: 2.0 KB · 4 prompts/);
  assert.match(handle.el.textContent, /ready · FTS5/);
  assert.equal(button("Import legacy data").hidden, false);
  assert.equal(button("Optimize storage").hidden, false);
  assert.equal(count(), before + 2);
  button("Close").click(); assert.equal(count(), before);
});

test("legacy confirmation reads the current snapshot and merges only on approval", async () => {
  env.api.route("/prompt_librarian/storage/migrate", { imported: 2, storage: snapshot({ records: 6, legacy: { available: false } }) });
  const storage = await actions.openStorage();
  shell.state.setState({ storage: snapshot({ legacy: { available: true, sources: ["new-fixture.jsonl", "second-fixture.json"] } }) });
  button("Import legacy data").click();
  const confirmation = shell.layers.topLayer();
  assert.match(confirmation.el.textContent, /new-fixture.jsonl and second-fixture.json/);
  assert.equal(env.api.callsTo("/storage/migrate").length, 0);
  button("Merge library").click(); await flush();
  assert.deepEqual(env.api.callsTo("/storage/migrate")[0].body, { source: "legacy" });
  assert.equal(env.api.callsTo("/taxonomy").length, 1);
  assert.equal(shell.it.state.storage.records, 6);
  assert.match(storage.el.textContent, /6 prompts/);
  assert.equal(button("Import legacy data").hidden, true);
  assert.match(shell.els.toasts.textContent, /imported 2 prompts/);
});

for (const cancel of ["button", "escape", "close modal"]) {
  test(`legacy import cancellation via ${cancel} performs no write`, async () => {
    await actions.openStorage(); button("Import legacy data").click();
    if (cancel === "button") button("Cancel").click();
    else if (cancel === "escape") shell.keyOn(button("Cancel"), "Escape");
    else shell.closeModal();
    await flush();
    assert.equal(env.api.callsTo("/storage/migrate").length, 0);
    assert.equal(env.api.callsTo("/taxonomy").length, 0);
    assert.equal(shell.it.state.storageBusy, false);
  });
}

test("dialog and footer share compaction, prevent concurrent writes, and update both views", async () => {
  const held = deferred();
  env.api.route("/prompt_librarian/storage/compact", () => held.promise);
  const handle = await actions.openStorage();
  button("Optimize storage").click();
  assert.equal(shell.it.state.storageBusy, true);
  assert.equal(await actions.optimizeStorage(), null);
  assert.equal(env.api.callsTo("/storage/compact").length, 1);
  held.resolve({ before: 4096, after: 2048, storage: snapshot({ should_compact: false }) });
  await flush();
  assert.equal(button("Optimize storage", handle.el).hidden, true);
  assert.equal(shell.els.storageHint.hidden, true);
  assert.match(shell.els.toasts.textContent, /reclaimed 2.0 KB/);
  assert.equal(shell.it.state.storageBusy, false);
  shell.state.setState({ storage: snapshot() });
  shell.els.storageHint.querySelector("button").click(); await flush();
  assert.equal(env.api.callsTo("/storage/compact").length, 2);
});

test("failed storage writes release busy state and leave the snapshot intact", async () => {
  env.api.route("/prompt_librarian/storage/compact", http({ status: 500, json: { error: "synthetic failure" } }));
  env.expectError(/optimize storage failed/);
  await actions.openStorage(); const before = shell.it.state.storage;
  assert.equal(await actions.optimizeStorage(), null);
  assert.equal(shell.it.state.storage, before);
  assert.equal(shell.it.state.storageBusy, false);
  assert.match(shell.els.toasts.textContent, /optimize storage/);
});

for (const mode of ["Merge", "Replace", "Cancel"]) {
  test(`JSON import preserves the ${mode} confirmation choice`, async () => {
    env.api.route("/prompt_librarian/import/file", { imported: 1 });
    await actions.openStorage();
    const file = new File(['{"records":[]}'], "synthetic-backup.json", { type: "application/json" });
    const pending = actions.importJson(file);
    assert.match(shell.layers.topLayer().el.textContent, /synthetic-backup.json/);
    button(mode).click(); await pending;
    const calls = env.api.callsTo("/import/file");
    if (mode === "Cancel") {
      assert.equal(calls.length, 0); assert.equal(env.api.callsTo("/taxonomy").length, 0);
    } else {
      assert.equal(calls.length, 1); assert.equal(calls[0].query.mode, mode.toLowerCase());
      assert.equal(calls[0].body.get("library").name, "synthetic-backup.json");
      assert.equal(env.api.callsTo("/taxonomy").length, 1);
      assert.equal(env.api.callsTo("/storage").length, 2);
    }
    assert.equal(shell.it.state.storageBusy, false);
  });
}

test("JSON export downloads the synthetic API blob and releases its URL", async () => {
  const { API } = await imp("prompt_librarian/api/routes.js");
  const blob = new Blob(['{"records":[]}'], { type: "application/json" });
  const exporter = mock.method(API, "exportFile", async () => blob);
  const create = mock.method(URL, "createObjectURL", () => "blob:synthetic");
  const revoke = mock.method(URL, "revokeObjectURL", () => {});
  let download;
  mock.method(env.window.HTMLAnchorElement.prototype, "click", function () { download = this.download; });
  await actions.exportJson(); await flush();
  assert.equal(exporter.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0], blob);
  assert.deepEqual(revoke.mock.calls[0].arguments, ["blob:synthetic"]);
  assert.match(download, /^prompt-library-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(document.querySelector("a[download]"), null);
});

test("closing during storage status fetch cannot open a late dialog", async () => {
  env.api.reset(); const held = deferred();
  env.api.route("/prompt_librarian/storage", () => held.promise);
  const pending = actions.openStorage(); shell.closeModal();
  held.resolve({ storage: snapshot() }); assert.equal(await pending, null);
  assert.equal(shell.it.layers.length, 0);
});

test("capability changes update retained storage controls", async () => {
  shell.state.setState({ storage: snapshot(), caps: { storage: false } });
  assert.equal(shell.els.storageBtn.hidden, true); assert.equal(shell.els.storageHint.hidden, true);
  shell.state.setState({ caps: { storage: true } });
  assert.equal(shell.els.storageBtn.hidden, false); assert.equal(shell.els.storageHint.hidden, false);
});
