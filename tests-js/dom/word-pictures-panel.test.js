/* ==========================================================================
   features/word-pictures/progress-panel.js and the gallery's picture entries.
   ========================================================================== */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const { ProgressPanel } = await imp("prompt_librarian/features/word-pictures/progress-panel.js");
const { pictureEntry } = await imp("prompt_librarian/features/gallery/words.js");

let env;
beforeEach(() => { env = setupDom(); });
afterEach(() => { env.assertNoErrors(); env.teardown(); });

const state = (over) => ({ total: 4, done: 1, failed: 1, current: "fox", running: true, stopped: false, error: "", ...over });

test("while running it counts, names the word and offers Stop", () => {
  let stops = 0;
  const panel = new ProgressPanel({ onStop: () => stops++ }).mount(document.body);
  panel.update(state());
  assert.match(panel.el.textContent, /Word pictures: 2 \/ 4/);
  assert.match(panel.el.textContent, /rendering “fox”/);
  assert.equal(panel.el.querySelector(".pl-wordgen-bar > div").style.width, "50%");
  panel.el.querySelector("button").click();
  assert.equal(stops, 1);
  panel.update(state({ stopped: true }));
  assert.match(panel.el.textContent, /stopping after this word/);
  assert.equal(panel.el.querySelector("button").disabled, true);
});

test("when the run ends it reports and Close removes the card", () => {
  const panel = new ProgressPanel({ onStop() {} }).mount(document.body);
  panel.update(state({ running: false, done: 3, failed: 1 }));
  assert.match(panel.el.textContent, /Word pictures: 3 made/);
  assert.match(panel.el.textContent, /1 words gave no image/);
  panel.el.querySelector("button").click();
  assert.equal(document.querySelector(".pl-wordgen"), null);
  assert.doesNotThrow(() => panel.update(state()), "a late update after Close is ignored");
});

test("pictureEntry keeps the fields a word's picture needs, or null when none is left", () => {
  assert.deepEqual(pictureEntry({ word: "fox", version: 2, source: "manual", pictures: [{ id: "a" }] }),
    { version: 2, source: "manual", page: "", pictures: [{ id: "a" }] });
  assert.equal(pictureEntry(null), null);
  assert.equal(pictureEntry({ removed: true }), null);
});
