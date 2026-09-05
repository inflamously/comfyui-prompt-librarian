import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { openShell, flush } from "../harness/modal.js";

let env, shell;
beforeEach(async () => {
  env = setupDom();
  shell = await openShell();
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  URL.revokeObjectURL = () => {};
});
afterEach(() => { shell.closeModal(); env.teardown(); });

const pics = (...ids) => ids.map((id, i) => ({ id, version: i + 1, source: "manual" }));
const entry = (ids, version = 10) => ({ version, source: "manual", page: "", pictures: pics(...ids) });

async function arrange(ids = ["a", "b", "c"], { confirm = true } = {}) {
  const { openArrange } = await imp("prompt_librarian/gallery/arrange.js");
  const calls = { order: [], remove: [], images: [], changes: [] };
  let current = entry(ids);
  const ctx = {
    API: {
      wordImage: async (word, v, _signal, id) => { calls.images.push([word, v, id]); return new Blob(["x"]); },
      orderWordImages: async (word, order) => {
        calls.order.push([word, order]);
        current = entry(order, current.version + 1);
        return { word, ...current };
      },
      removeWordImage: async (word, id) => {
        calls.remove.push([word, id]);
        const left = current.pictures.map((p) => p.id).filter((p) => p !== id);
        current = left.length ? entry(left, current.version + 1) : null;
        return { word, removed: true, image: current };
      },
    },
    pushLayer: shell.layers.pushLayer,
    popLayer: shell.layers.popLayer,
    confirmDialog: async () => confirm,
    reportError: (err) => { throw err; },
  };
  const item = { word: "fox", uses: 3, picture: entry(ids) };
  const handle = openArrange({ ctx, item, onChange: (p) => calls.changes.push(p) });
  await flush();
  const el = handle.el;
  const slots = () => [...el.querySelectorAll(".pl-arrange-slot")];
  const filled = () => slots().filter((s) => s.classList.contains("is-filled"));
  const tool = (label) => el.querySelector(`[aria-label="${label}"]`);
  return { el, calls, slots, filled, tool };
}

test("layout grows 1x1, 2x1, 2x2, 3x2, 3x3", async () => {
  const { gridSize } = await imp("prompt_librarian/gallery/arrange.js");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 9].map(gridSize),
    [[1, 1], [2, 1], [2, 2], [2, 2], [3, 2], [3, 2], [3, 3], [3, 3]]);
});

test("nine slots: pictures in order, the rest empty, and the image as shown", async () => {
  const a = await arrange();
  assert.equal(a.slots().length, 9);
  assert.equal(a.filled().length, 3);
  assert.match(a.el.textContent, /3 of 9 · shown as 2×2/);
  assert.deepEqual(a.calls.images.filter(([, , id]) => id).map(([, , id]) => id), ["a", "b", "c"],
    "each slot loads its own picture");
  assert.ok(a.calls.images.some(([, v, id]) => v === 10 && id === undefined), "the shown image loads too");
  assert.equal(a.tool("move picture 1 earlier").disabled, true);
  assert.equal(a.tool("move picture 3 later").disabled, true);
});

test("arrows reorder through the server and report the new entry", async () => {
  const a = await arrange();
  a.tool("move picture 1 later").click(); await flush();
  assert.deepEqual(a.calls.order, [["fox", ["b", "a", "c"]]]);
  assert.deepEqual(a.calls.changes.at(-1).pictures.map((p) => p.id), ["b", "a", "c"]);
  a.tool("move picture 3 earlier").click(); await flush();
  assert.deepEqual(a.calls.order.at(-1), ["fox", ["b", "c", "a"]]);
  assert.ok(a.el.contains(document.activeElement), "focus stays in the dialog after a repaint");
  shell.keyOn(document.activeElement, "Escape");
  assert.equal(shell.layers.topLayer(), null, "so Esc still closes it");
});

test("dragging onto an empty slot moves a picture to the end", async () => {
  const a = await arrange();
  const drag = (el, type) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: null }));
  drag(a.filled()[0], "dragstart");
  drag(a.slots()[7], "drop");
  await flush();
  assert.deepEqual(a.calls.order, [["fox", ["b", "c", "a"]]]);
});

test("remove asks first, then shrinks the layout; the last one closes nothing but empties it", async () => {
  const refused = await arrange(["a", "b"], { confirm: false });
  refused.tool("remove picture 1").click(); await flush();
  assert.deepEqual(refused.calls.remove, []);
  shell.closeModal(); shell = await openShell();

  const a = await arrange(["a", "b"]);
  a.tool("remove picture 1").click(); await flush();
  assert.deepEqual(a.calls.remove, [["fox", "a"]]);
  assert.match(a.el.textContent, /1 of 9 · shown as 1×1/);
  a.tool("remove picture 1").click(); await flush();
  assert.equal(a.calls.changes.at(-1), null, "the gallery hears the word has no pictures");
  assert.match(a.el.textContent, /no pictures left/);
});
