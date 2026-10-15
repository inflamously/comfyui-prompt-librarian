/* ==========================================================================
   features/compare: the diff view, the compare dialog, the merge editor and
   the version history, opened through createCompare on a real layer stack.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { flush } from "../harness/modal.js";
import { immediateLane } from "../harness/inspector.js";

const C = "prompt_librarian/features/compare/";
const { createCompare } = await imp(C + "index.js");
const { DiffView, MAX_TOKENS_PER_SIDE } = await imp(C + "diff-view.js");
const { reconstruct, mergeSeed } = await imp(C + "opcodes.js");
const { shortLabel } = await imp(C + "text.js");
const { LayerStack } = await imp("prompt_librarian/shared/ui/layer-stack.js");
const { installKeyGuards } = await imp("prompt_librarian/shared/keys.js");

let env, host, layers, uninstall;
beforeEach(() => {
  env = setupDom();
  host = document.createElement("div");
  document.body.append(host);
  layers = new LayerStack(host);
  uninstall = installKeyGuards(host);
});
afterEach(() => { uninstall(); env.assertNoErrors(); env.teardown(); });

const OPS = [
  { op: "equal", a_tokens: ["a", "red"], b_tokens: ["a", "red"] },
  { op: "replace", a_tokens: ["fox"], b_tokens: ["cat"] },
  { op: "insert", a_tokens: [], b_tokens: ["sleeps"] },
];

function service(over = {}) {
  const calls = { confirm: [], toasts: [], refreshed: 0, loaded: [], api: [] };
  const record = (id, body) => ({ ok: true, record: { id, body, label: id + "_label", updated: "T0" } });
  const api = {
    compare: async (p) => { calls.api.push(["compare", p]); return { diff: OPS, pct: 80, summary: "fox → cat" }; },
    update: async (p) => { calls.api.push(["update", p]); return record(p.id, p.body); },
    merge: async (p) => { calls.api.push(["merge", p]); return record(p.winner_id, "merged"); },
    mergeNew: async (p) => { calls.api.push(["mergeNew", p]); return record("n1", p.body); },
    create: async (p) => { calls.api.push(["create", p]); return record("n1", p.body); },
    ignorePair: async (a, b) => { calls.api.push(["ignorePair", a, b]); return { ok: true }; },
    get: async (id) => record(id, "current body"),
    versions: async () => ({ versions: [{ index: 0, preview: "oldest", chars: 6, ts: "" }, { index: 1, preview: "older", chars: 5, ts: "" }] }),
    version: async (id, index) => ({ version: { body: `body of v${index}` } }),
    restoreVersion: async (id, index) => { calls.api.push(["restore", id, index]); return record(id, `body of v${index}`); },
    ...over.api,
  };
  const svc = createCompare({
    api,
    lanes: { diff: over.lane || immediateLane(), versions: immediateLane() },
    layers: () => layers,
    confirm: async (o) => { calls.confirm.push(o); return over.confirm ?? true; },
    toast: (m) => calls.toasts.push(m),
    loadIntoNode: (rec) => { calls.loaded.push(rec); return { ok: true }; },
    onLibraryChanged: () => { calls.refreshed++; },
    isNarrow: () => !!over.narrow,
  });
  return { svc, calls };
}

const button = (el, key) => el.querySelector(`[data-act="${key}"]`);

describe("opcodes and labels", () => {
  test("reconstruct rebuilds either side", () => {
    assert.equal(reconstruct(OPS, "a"), "a red fox");
    assert.equal(reconstruct(OPS, "b"), "a red cat sleeps");
  });

  test("mergeSeed keeps equal runs once and both sides' own words", () => {
    assert.equal(mergeSeed(OPS, "", ""), "a red fox cat sleeps");
    assert.equal(mergeSeed([], "one", "two"), "one\n\ntwo");
    assert.equal(mergeSeed(null, "same", "same"), "same");
  });

  test("shortLabel prefers the label and cuts long text at a word", () => {
    assert.equal(shortLabel({ label: " named ", body: "x" }), "named");
    assert.equal(shortLabel({ body: "word ".repeat(40) }).endsWith("…"), true);
  });
});

describe("DiffView", () => {
  test("split mode keeps both columns index-aligned, with empty placeholders", () => {
    const view = new DiffView({ opcodes: OPS, a: "a red fox", b: "a red cat sleeps", mode: "split" }).mount(host);
    const [left, right] = host.querySelectorAll(".pl-diff-col");
    assert.equal(left.children.length, 3);
    assert.equal(right.children.length, 3);
    assert.ok(left.children[2].classList.contains("is-empty"), "the insert has a placeholder on the left");
    assert.ok(left.children[1].classList.contains("pl-del") && right.children[1].classList.contains("pl-ins"));
    view.destroy();
    assert.equal(host.children.length, 0);
  });

  test("unified mode shows one column with inline changes", () => {
    new DiffView({ opcodes: OPS, mode: "unified" }).mount(host);
    const cols = host.querySelectorAll(".pl-diff-col");
    assert.equal(cols.length, 1);
    assert.equal(cols[0].querySelector(".pl-del").textContent, "fox");
    assert.equal(cols[0].textContent, "a red fox cat sleeps");
  });

  test("long bodies are capped per side and say so", () => {
    const many = Array.from({ length: MAX_TOKENS_PER_SIDE + 10 }, (_, i) => "w" + i);
    new DiffView({ opcodes: [{ op: "equal", a_tokens: many, b_tokens: many }], mode: "split" }).mount(host);
    assert.match(host.querySelector("[data-pl-notice]").textContent, /showing first 5\D?000 of 5\D?010 tokens/);
  });
});

describe("the compare dialog", () => {
  test("loads the diff, the match and the summary", async () => {
    const { svc } = service();
    const dlg = svc.compare({ a_id: "a", a_text: "a red fox", b_id: "b", b_text: "a red cat sleeps", titleA: "A", titleB: "B" });
    await flush();
    assert.equal(layers.size, 1);
    assert.match(dlg.el.textContent, /80% match/);
    assert.match(dlg.el.textContent, /differs: fox → cat/);
    assert.equal(button(dlg.el, "merge").disabled, false);
  });

  test("an action that cannot apply is disabled and says why", async () => {
    const { svc } = service();
    const dlg = svc.compare({ a_text: "draft", b_id: "b", b_text: "saved" });
    await flush();
    assert.equal(button(dlg.el, "keep_right").disabled, true);
    assert.match(button(dlg.el, "keep_right").title, /left side is not a saved prompt/);
    assert.match(button(dlg.el, "merge").title, /both sides must be saved prompts/);
  });

  test("merge confirms, merges b into a, refreshes and closes", async () => {
    const { svc, calls } = service();
    const dlg = svc.compare({ a_id: "a", b_id: "b", a_text: "x", b_text: "y" });
    await flush();
    button(dlg.el, "merge").click();
    await flush();
    assert.equal(calls.confirm.length, 1);
    assert.deepEqual(calls.api.find((c) => c[0] === "merge")[1], { winner_id: "a", loser_id: "b" });
    assert.equal(calls.refreshed, 1);
    assert.equal(layers.size, 0);
  });

  test("keep both still works when the diff request failed", async () => {
    const { svc, calls } = service({ api: { compare: async () => { throw new Error("offline"); } } });
    const dlg = svc.compare({ a_id: "a", b_id: "b", a_text: "x", b_text: "y" });
    await flush();
    assert.match(dlg.el.textContent, /compare failed: offline/);
    assert.equal(button(dlg.el, "merge").disabled, true, "needs the diff");
    button(dlg.el, "keep_both").click();
    await flush();
    assert.deepEqual(calls.api.at(-1), ["ignorePair", "a", "b"]);
  });

  test("a side given only by id gets its text back from the diff", async () => {
    const { svc, calls } = service();
    const dlg = svc.compare({ a_id: "a", b_id: "b" });
    await flush();
    assert.deepEqual(calls.api[0][1], { a_id: "a", b_id: "b" }, "no empty text is sent for an id-only side");
    assert.equal(dlg.aText, "a red fox");
    assert.equal(dlg.bText, "a red cat sleeps");
  });

  test("U switches between split and unified; narrow screens start unified", async () => {
    const { svc } = service();
    const dlg = svc.compare({ a_text: "x", b_text: "y" });
    await flush();
    assert.equal(dlg.mode, "split");
    dlg.el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "u", bubbles: true, cancelable: true }));
    assert.equal(dlg.mode, "unified");
    assert.equal(service({ narrow: true }).svc.compare({ a_text: "x", b_text: "y" }).mode, "unified");
  });

  test("closing while the diff loads cancels the request", async () => {
    let cancelled = 0;
    const lane = (run) => new Promise(() => run(undefined));
    lane.cancel = () => { cancelled++; };
    const { svc } = service({ lane });
    svc.compare({ a_text: "x", b_text: "y" });
    layers.pop();
    assert.equal(cancelled, 1);
  });

  test("merge → new opens the editor seeded with the union; saving absorbs both and closes both", async () => {
    const { svc, calls } = service();
    const dlg = svc.compare({ a_id: "a", b_id: "b", a_text: "a red fox", b_text: "a red cat sleeps" });
    await flush();
    button(dlg.el, "merge_new").click();
    await flush();
    const editor = layers.top().el;
    assert.equal(editor.querySelector("textarea").value, "a red fox cat sleeps");
    editor.querySelector("textarea").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    assert.deepEqual(calls.api.find((c) => c[0] === "mergeNew")[1], { a_id: "a", b_id: "b", body: "a red fox cat sleeps" });
    assert.equal(layers.size, 0, "the editor and the compare dialog under it");
  });

  test("the merge editor creates (with the left tags) when only one side is saved, and refuses an empty body", async () => {
    const { svc, calls } = service();
    const dlg = svc.compare({ a_text: "draft", b_id: "b", b_text: "saved" });
    await flush();
    button(dlg.el, "merge_new").click();
    await flush();
    const editor = layers.top().el;
    editor.querySelector("textarea").value = "  ";
    button(editor, "save").click();
    await flush();
    assert.match(calls.toasts.at(-1), /merged body is empty/);
    editor.querySelector("textarea").value = "kept";
    button(editor, "save").click();
    await flush();
    assert.deepEqual(calls.api.find((c) => c[0] === "create")[1], { body: "kept", tags: [] });
    assert.equal(calls.confirm.length, 0, "nothing existing is touched, so nothing to confirm");
  });
});

describe("the version history", () => {
  test("lists the current body then snapshots newest first, and opens on the newest", async () => {
    const { svc } = service();
    const dlg = svc.versions({ id: "a", record: { id: "a", body: "current body", label: "A" } });
    await flush();
    const labels = [...dlg.el.querySelectorAll(".pl-row .pl-row-name")].map((n) => n.textContent);
    assert.deepEqual(labels, ["A", "version 2", "version 1"]);
    assert.equal(dlg.selected, 1);
    assert.equal(dlg.pane.state, "ready");
    assert.equal(dlg.bodyFor(dlg.rows[1]), "body of v1");
  });

  test("restore confirms, restores, tells the inspector and reloads", async () => {
    const restored = [];
    const { svc, calls } = service();
    const dlg = svc.versions({ id: "a", record: { id: "a", body: "current body" }, onRestored: (r) => restored.push(r.body) });
    await flush();
    button(dlg.el, "restore").click();
    await flush();
    assert.deepEqual(calls.api.find((c) => c[0] === "restore"), ["restore", "a", 1]);
    assert.deepEqual(restored, ["body of v1"]);
    assert.equal(dlg.currentBody, "body of v1");
    assert.equal(calls.refreshed, 1);
  });

  test("load into node sends the snapshot without saving", async () => {
    const { svc, calls } = service();
    const dlg = svc.versions({ id: "a", record: { id: "a", body: "current body" } });
    await flush();
    button(dlg.el, "load").click();
    assert.equal(calls.loaded[0].body, "body of v1");
    assert.match(calls.toasts.at(-1), /not saved/);
  });

  test("arrow keys move the highlight at once and load when navigation pauses", async () => {
    const { svc } = service();
    const dlg = svc.versions({ id: "a", record: { id: "a", body: "current body" } });
    await flush();
    dlg.el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    assert.equal(dlg.selected, 2);
    assert.equal(dlg.pane.version.index, 1, "the body has not been fetched yet");
    await flush(150);
    assert.equal(dlg.pane.version.index, 0);
  });

  test("a stale snapshot answer never overwrites a newer selection", async () => {
    const gates = [];
    const { svc } = service({ api: { version: (id, index) => new Promise((r) => gates.push(() => r({ version: { body: `v${index}` } }))) } });
    const dlg = svc.versions({ id: "a", record: { id: "a", body: "current body" } });
    await flush();
    dlg.select(2);
    gates[1]();
    gates[0]();
    await flush();
    assert.equal(dlg.pane.version.index, 0, "the newer selection won");
  });

  test("long histories are virtualised", async () => {
    const versions = Array.from({ length: 70 }, (_, i) => ({ index: i, preview: "p" + i }));
    const { svc } = service({ api: { versions: async () => ({ versions }) } });
    const dlg = svc.versions({ id: "a", record: { id: "a", body: "current body" } });
    await flush();
    assert.ok(dlg.vlist, "a virtual list");
    assert.ok(dlg.el.querySelectorAll(".pl-row").length < 71, "not every row is in the DOM");
  });
});
