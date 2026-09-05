import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { openShell, flush } from "../harness/modal.js";

let env, shell, urls;
beforeEach(async () => {
  env = setupDom();
  shell = await openShell();
  urls = { made: 0, revoked: 0 };
  URL.createObjectURL = () => `blob:test/${++urls.made}`;
  URL.revokeObjectURL = () => { urls.revoked += 1; };
});
afterEach(() => { shell.closeModal(); env.teardown(); });

const WORDS = [
  { word: "misty", uses: 4, picture: { version: 3, source: "generated", page: "" } },
  { word: "golden hour", uses: 2, picture: null },
  { word: "gloomy", uses: 1, picture: null },
];
const MISTY = {
  word: "misty", status: "found", lemma: "misty", parts: [], source: "WordNet 3.0, Princeton University",
  meanings: [{
    part: "adjective", definitions: ["filled with mist"], examples: ["a misty morning"],
    synonyms: ["gloomy", "hazy"], antonyms: ["clear"],
  }],
};

async function open({
  define = async () => MISTY,
  searchDictionary = async () => ({ installed: true, words: [] }),
  installDictionary = async () => ({ installed: true, words: 147306, error: "" }),
  body = "a lake",
} = {}) {
  const { openGallery } = await imp("prompt_librarian/gallery/index.js");
  const { onKey } = await imp("prompt_librarian/modal/input/keys.js");
  const calls = { define: [], wordImage: [], search: [], toasts: [], dict: [], installs: 0 };
  const buffer = body;
  const ctx = {
    API: {
      gallery: async () => ({ words: WORDS, total: WORDS.length }),
      define: async (word) => { calls.define.push(word); return define(word); },
      wordImage: async (word, v) => { calls.wordImage.push([word, v]); return new Blob(["x"]); },
      searchDictionary: async (q) => { calls.dict.push(q); return searchDictionary(q); },
      installDictionary: async () => { calls.installs += 1; return installDictionary(); },
    },
    onKey,
    pushLayer: shell.layers.pushLayer,
    popLayer: shell.layers.popLayer,
    reportError: (err) => { throw err; },
    toast: (msg) => calls.toasts.push(msg),
    inspector: { getBuffer: () => ({ body: buffer, tags: [] }) },
    list: { search: async (q) => calls.search.push(q) },
    getTargetNodeId: () => 1,
    app: null,
  };
  const handle = openGallery(ctx);
  await flush();
  const el = handle.el;
  const tiles = () => [...el.querySelectorAll(".pl-gallery-tile")];
  const tile = (word) => tiles().find((t) => t.querySelector(".pl-gallery-word").textContent === word);
  const button = (text) => [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  const type = async (value, key) => {
    const search = el.querySelector(".pl-gallery-search");
    search.value = value; search.dispatchEvent(new Event("input"));
    if (key) search.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await flush(200);
  };
  return { handle, el, calls, tiles, tile, button, type };
}

test("the gallery button sits just left of the linked chip", async () => {
  const head = shell.els.link.parentNode;
  const kids = [...head.children];
  assert.equal(kids.indexOf(shell.els.gallery) + 1, kids.indexOf(shell.els.link));
  assert.equal(shell.els.gallery.textContent, "gallery");
});

test("tiles list the vocabulary and filter by picture and text", async () => {
  const g = await open();
  assert.deepEqual(g.tiles().map((t) => t.querySelector(".pl-gallery-word").textContent),
    ["misty", "golden hour", "gloomy"]);
  assert.deepEqual(g.calls.wordImage, [["misty", 3]], "only pictured words fetch a thumbnail");
  g.button("with picture").click();
  assert.equal(g.tiles().length, 1);
  g.button("all").click();
  await g.type("GOL");
  assert.equal(g.tiles().length, 1);
  assert.match(g.el.querySelector(".pl-gallery-count").textContent, /1 word$/);
});

test("picking a word shows its definition, example and source; related words jump", async () => {
  const g = await open();
  g.tile("misty").click(); await flush();
  const entry = g.el.querySelector(".pl-gallery-entry");
  assert.match(entry.textContent, /filled with mist/);
  assert.equal(entry.querySelector(".pl-gallery-example").textContent, "“a misty morning”");
  assert.match(entry.textContent, /used in 4 of your prompts/);
  assert.match(entry.textContent, /from WordNet 3\.0/);
  assert.equal(g.button("insert into prompt"), undefined, "insert is gone");
  g.button("gloomy").click(); await flush();
  assert.deepEqual(g.calls.define, ["misty", "gloomy"]);
  assert.equal(g.tile("gloomy").getAttribute("aria-selected"), "true");
  g.button("hazy").click(); await flush();
  assert.equal(g.el.querySelector(".pl-gallery-entry-word").textContent, "hazy",
    "a related word outside the vocabulary still opens");
  assert.match(g.el.textContent, /not in your prompts yet/);
  assert.equal(g.button("find my prompts"), undefined, "nothing to find for a word you never used");
});

test("the dictionary downloads once on request, then the word shows", async () => {
  let installed = false;
  const g = await open({
    define: async () => (installed ? MISTY : { word: "misty", status: "not_installed", meanings: [], parts: [] }),
    installDictionary: async () => { installed = true; return { installed: true, words: 147306, error: "" }; },
  });
  g.tile("misty").click(); await flush();
  assert.match(g.el.textContent, /not downloaded yet/);
  g.button("download dictionary (11 MB, once)").click(); await flush();
  assert.equal(g.calls.installs, 1);
  assert.match(g.el.textContent, /filled with mist/);
  assert.match(g.calls.toasts.join(), /dictionary ready/);
});

test("a failed download says why and can be tried again", async () => {
  const g = await open({
    define: async () => ({ word: "misty", status: "not_installed", meanings: [], parts: [] }),
    installDictionary: async () => ({ installed: false, words: 0, error: "403 from github" }),
  });
  g.tile("misty").click(); await flush();
  g.button("download dictionary (11 MB, once)").click(); await flush();
  assert.match(g.calls.toasts.join(), /403 from github/);
  g.button("download dictionary (11 MB, once)").click(); await flush();
  assert.equal(g.calls.installs, 2);
});

test("a missing phrase offers its known words", async () => {
  const g = await open({ define: async (w) => (w === "golden hour"
    ? { word: w, status: "missing", meanings: [], parts: ["golden", "hour"] } : MISTY) });
  g.tile("golden hour").click(); await flush();
  assert.match(g.el.textContent, /Not in the dictionary as a phrase/);
  g.button("hour").click(); await flush();
  assert.equal(g.el.querySelector(".pl-gallery-entry-word").textContent, "hour");
});

test("search also lists dictionary words; Enter opens the typed word", async () => {
  const g = await open({ searchDictionary: async () => ({ installed: true, words: ["mist", "misty", "mistral"] }) });
  await g.type("mist");
  const chips = [...g.el.querySelectorAll(".pl-gallery-dict .pl-gallery-chip")].map((c) => c.textContent);
  assert.deepEqual(chips, ["mist", "mistral"], "words already shown as tiles are not repeated");
  g.button("mistral").click(); await flush();
  assert.equal(g.el.querySelector(".pl-gallery-entry-word").textContent, "mistral");
  await g.type("fog", "Enter");
  assert.equal(g.el.querySelector(".pl-gallery-entry-word").textContent, "fog");
  await g.type("glo", "Enter");
  assert.equal(g.el.querySelector(".pl-gallery-entry-word").textContent, "gloomy", "one match opens its tile");
});

test("search offers the download while the dictionary is missing", async () => {
  const g = await open({ searchDictionary: async () => ({ installed: false, words: [] }) });
  await g.type("mist");
  g.button("download dictionary (11 MB, once)").click(); await flush();
  assert.equal(g.calls.installs, 1);
});

test("find searches Browse and closes", async () => {
  const g = await open();
  g.tile("golden hour").click(); await flush();
  g.button("find my prompts").click(); await flush();
  assert.deepEqual(g.calls.search, ['"golden hour"']);
  assert.equal(shell.layers.topLayer(), null, "the gallery closed");
  assert.ok(urls.revoked >= 1, "thumbnails are released on close");
});

test("Escape closes the gallery", async () => {
  await open();
  shell.key("Escape");
  assert.equal(shell.layers.topLayer(), null);
});

test("A/B texts add the word, or take it out when the prompt has it", async () => {
  const { withAndWithout } = await imp("prompt_librarian/gallery/compare.js");
  assert.deepEqual(withAndWithout("a lake, ", "misty"), { a: "a lake,", b: "a lake, misty", had: false });
  assert.deepEqual(withAndWithout("", "misty"), { a: "", b: "misty", had: false });
  assert.deepEqual(withAndWithout("a Misty lake, dawn", "misty"),
    { a: "a lake, dawn", b: "a Misty lake, dawn", had: true });
  assert.deepEqual(withAndWithout("portrait, golden  hour, film", "golden hour"),
    { a: "portrait, film", b: "portrait, golden  hour, film", had: true });
  assert.equal(withAndWithout("mistyness", "misty").had, false, "whole words only");
});

test("compare renders A then B through the workflow with the same graph", async () => {
  const { runCompare } = await imp("prompt_librarian/gallery/compare.js");
  const output = {
    1: { class_type: "PromptLibrarian", inputs: { text: "x" } },
    2: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 4 } },
    3: { class_type: "SaveImage", inputs: { images: ["4", 0] } },
  };
  const queued = [];
  const listeners = new Map();
  const host = {
    available: () => true,
    on: (type, fn) => { listeners.set(type, fn); return () => listeners.delete(type); },
    queue: async (prompt) => {
      queued.push(prompt);
      const id = `p${queued.length}`;
      setTimeout(() => {
        listeners.get("executed")({ prompt_id: id, output: { images: [{ filename: `${id}.png`, type: "temp" }] } });
        listeners.get("execution_success")({ prompt_id: id });
      });
      return { prompt_id: id };
    },
  };
  const steps = [];
  const result = await runCompare({
    app: { graphToPrompt: async () => ({ output }) }, nodeId: 1, base: "a lake", word: "misty",
    host, onStep: (s) => steps.push(s),
  });
  assert.deepEqual(steps, ["a", "b"]);
  assert.deepEqual(queued.map((p) => p[1].inputs.text), ["a lake", "a lake, misty"]);
  assert.equal(queued[0][3].class_type, "PreviewImage", "nothing lands in the output folder");
  assert.equal(result.imageA.filename, "p1.png");
  assert.equal(result.imageB.filename, "p2.png");
});

test("pictured words offer arranging; changes repaint the tile", async () => {
  const g = await open();
  g.tile("golden hour").click(); await flush();
  assert.equal(g.button("arrange pictures (0/9)")?.hidden ?? true, true, "nothing to arrange");
  g.tile("misty").click(); await flush();
  const before = g.calls.wordImage.length;
  g.button("arrange pictures (1/9)").click(); await flush();
  const layer = shell.layers.topLayer();
  assert.ok(layer.el.classList.contains("pl-arrange"));
  assert.match(layer.el.textContent, /Pictures for “misty”/);
  assert.ok(g.calls.wordImage.length > before, "the arrange dialog loads the pictures");
});
