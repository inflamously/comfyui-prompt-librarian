import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { flush } from "../harness/modal.js";

let env, cleanup, urls;
beforeEach(() => {
  env = setupDom();
  cleanup = [];
  // jsdom has no object URLs; record them instead.
  urls = { made: 0, revoked: 0 };
  URL.createObjectURL = () => `blob:test/${++urls.made}`;
  URL.revokeObjectURL = () => { urls.revoked += 1; };
});
afterEach(() => { for (const fn of cleanup) fn(); env.teardown(); });

const item = (text) => ({ text, scope: "word", source_count: 1 });

const pic = (version, source = "generated", page = "") => ({ version, source, page });

async function mount(images = { volume: pic(7) }) {
  const { attachAutocomplete } = await imp("prompt_librarian/inspector/autocomplete.js");
  const host = document.createElement("div");
  host.className = "pl-root";
  const ta = document.createElement("textarea");
  host.appendChild(ta); document.body.appendChild(host);
  const fetched = [];
  const listings = [];
  const removed = [];
  const API = {
    autocomplete: async () => ({ suggestions: [item("volume"), item("violet")] }),
    wordImages: async () => { listings.push(1); return { images }; },
    wordImage: async (word, v) => { fetched.push([word, v]); return new Blob(["x"]); },
    removeWordImage: async (word) => { removed.push(word); return { removed: true }; },
  };
  const ac = attachAutocomplete(ta, { API }, host);
  cleanup.push(() => ac.detach());
  const type = (value) => {
    ta.focus(); ta.value = value; ta.setSelectionRange(value.length, value.length);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (k) => ta.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const box = () => host.querySelector(".pl-word-preview");
  return { ta, host, ac, API, fetched, listings, removed, type, key, box,
    menu: host.querySelector(".pl-autocomplete") };
}

test("the highlighted word's picture shows after the highlight settles", async () => {
  const h = await mount();
  await flush();
  h.type("vo"); await flush();
  assert.equal(h.fetched.length, 0, "nothing loads before the highlight settles");
  assert.ok(h.menu.children[0].classList.contains("has-picture"));
  assert.ok(!h.menu.children[1].classList.contains("has-picture"));
  await flush(150);
  assert.deepEqual(h.fetched, [["volume", 7]], "the version rides along for caching");
  assert.equal(h.box().hidden, false);
  assert.equal(h.box().querySelector("img").src, "blob:test/1");
});

test("a word without a picture makes no request and hides the preview", async () => {
  const h = await mount();
  await flush();
  h.type("vo"); await flush(150);
  h.key("ArrowDown"); await flush(150);
  assert.equal(h.box().hidden, true);
  assert.equal(h.fetched.length, 1, "violet has no picture, so nothing is fetched");
  h.key("ArrowUp"); await flush(150);
  assert.equal(h.box().hidden, false);
  assert.equal(h.fetched.length, 1, "returning to a shown word reuses its image");
});

test("a picture generated in this page shows without refetching the listing", async () => {
  const h = await mount({});
  const { rememberPicture } = await imp("prompt_librarian/inspector/word-preview.js");
  await flush();
  rememberPicture("Violet", { version: 4, source: "generated" });
  h.type("vo"); await flush(150);
  h.key("ArrowDown"); await flush(150);
  assert.deepEqual(h.fetched, [["violet", 4]]);
  assert.equal(h.listings.length, 1);
});

test("dismissing the menu hides the preview and detach removes it", async () => {
  const h = await mount();
  await flush();
  h.type("vo"); await flush(150);
  h.key("Escape");
  assert.equal(h.box().hidden, true);
  h.ac.detach(); cleanup.length = 0;
  assert.equal(h.box(), null);
  assert.equal(urls.revoked, 1);
});

test("the listing is fetched once per page, and a removed word stays removed", async () => {
  const h = await mount();
  await flush();
  h.type("vo"); await flush(150);
  assert.equal(h.listings.length, 1);
  h.box().querySelector(".pl-word-preview-remove").click(); await flush();
  assert.deepEqual(h.removed, ["volume"]);
  assert.equal(h.box().hidden, true);
  assert.equal(h.listings.length, 1);
  h.key("ArrowDown"); await flush(150); h.key("ArrowUp"); await flush(150);
  assert.equal(h.box().hidden, true, "a removed picture is gone for good");
});

test("node menu offers picking for image nodes and generating on the Librarian", async () => {
  const { addWordPictureMenu, shownImageRef } = await imp("prompt_librarian/node/word-picture-menu.js");
  function Node() {}
  Node.prototype.getExtraMenuOptions = function (_c, options) { options.push({ content: "core" }); };
  addWordPictureMenu(Node, {});
  addWordPictureMenu(Node, {});
  const plain = new Node();
  const options = [];
  plain.getExtraMenuOptions(null, options);
  assert.deepEqual(options.map((o) => o.content), ["core"]);

  const shown = new Node();
  shown.imgs = [{ src: "/api/view?filename=gen_01.png&subfolder=a&type=output&rand=1" }];
  const more = [];
  shown.getExtraMenuOptions(null, more);
  assert.deepEqual(more.map((o) => o.content), ["core", "🖼️ Use as picture for words…"],
    "wrapping twice still adds the item once");
  assert.deepEqual(shownImageRef(shown), { filename: "gen_01.png", subfolder: "a", type: "output" });
  assert.deepEqual(
    shownImageRef({ images: [{ filename: "p.png", type: "temp" }] }),
    { filename: "p.png", subfolder: "", type: "temp" },
  );
  const librarian = new Node();
  librarian.comfyClass = "PromptLibrarian";
  const own = [];
  librarian.getExtraMenuOptions(null, own);
  assert.deepEqual(own.map((o) => o.content), ["core", "Generate word pictures…"]);
});

test("the picture dialog takes several words, separated by spaces or commas", async () => {
  const { askWords, isSingleWord, splitWords } = await imp("prompt_librarian/node/word-picture-menu.js");
  for (const ok of ["fox", " Fox ", "1girl", "red_fox", "café"]) assert.ok(isSingleWord(ok), ok);
  for (const bad of ["red fox", "fox,", "close-up", "(fox:1.2)", ""]) assert.ok(!isSingleWord(bad), bad);
  assert.deepEqual(splitWords(" red, fox  Fox,,forest "), ["red", "fox", "forest"]);

  const asked = [];
  const answers = ["red fox, close-up", "  red fox, forest "];
  const app = { extensionManager: { dialog: { prompt: async (opts) => { asked.push(opts); return answers.shift(); } } } };
  assert.deepEqual(await askWords(app), ["red", "fox", "forest"]);
  assert.equal(asked.length, 2);
  assert.match(asked[1].message, /“close-up” is not a word/);
  assert.equal(asked[1].defaultValue, "red fox, close-up", "the rejected text is kept for editing");

  const cancel = { extensionManager: { dialog: { prompt: async () => null } } };
  assert.equal(await askWords(cancel), null);
});

test("the toast names who got the picture and who was full", async () => {
  const { attachSummary } = await imp("prompt_librarian/node/word-picture-menu.js");
  assert.equal(attachSummary({ word: "fox", words: [{ word: "fox" }, { word: "red" }], skipped: [] }),
    "added to “fox”, “red”");
  assert.equal(attachSummary({ word: "fox", words: [{ word: "fox" }], skipped: ["cat"] }),
    "added to “fox”; “cat” already has 9 pictures");
});
