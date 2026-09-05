/* ==========================================================================
   devharness/ — the dev playground's own source

   These files are only ever executed by a browser talking to
   scripts/devkit/server.py, so nothing else in the suite would notice a typo in
   them until the page was opened. This is the cheap standing check: every
   harness module parses, resolves its imports, and does not touch the DOM at
   import time.

   The two devharness/scripts/*.js stubs are deliberately excluded — they import
   absolute server URLs (`/__dev/harness/...`) that only resolve over HTTP, by
   design, since ComfyUI serves them from a fixed path.
   ========================================================================== */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT } from "./harness/mount.js";

const DEVHARNESS = path.join(ROOT, "devharness");

/** Modules that can be imported without a browser (no absolute URL imports). */
const IMPORTABLE = ["harness/fake-api.js", "harness/fake-app.js", "harness/fake-node.js", "harness/boot.js"];

/** Served-path stubs; they resolve only over HTTP, so they are parse-checked. */
const URL_IMPORTERS = ["scripts/app.js", "scripts/api.js"];

/** ui.js drives the page: it reads DOM elements at module scope by design. */
const PAGE_ENTRY = "harness/ui.js";

const read = (rel) => fs.readFileSync(path.join(DEVHARNESS, rel), "utf8");

describe("devharness", () => {
  test("the files the dev server serves all exist", () => {
    for (const rel of [...IMPORTABLE, ...URL_IMPORTERS, PAGE_ENTRY, "index.html", "harness/harness.css"]) {
      assert.ok(fs.existsSync(path.join(DEVHARNESS, rel)), `missing devharness/${rel}`);
    }
  });

  test("every importable harness module loads cleanly", async () => {
    // Importing also resolves their relative specifiers, so a renamed file is
    // a failure here rather than a blank page later.
    const failures = [];
    for (const rel of IMPORTABLE) {
      try {
        await import(pathToFileURL(path.join(DEVHARNESS, rel)).href);
      } catch (err) {
        failures.push(`${rel}: ${String(err).split("\n")[0]}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test("the harness modules do no DOM work at import time", () => {
    // They are imported above with no jsdom installed at all, so this is
    // already proven — but assert the intent so the reason survives.
    assert.equal(typeof globalThis.document, "undefined");
  });

  test("the served stubs re-export from the harness, not from ComfyUI", () => {
    for (const rel of URL_IMPORTERS) {
      const src = read(rel);
      assert.match(src, /from "\/__dev\/harness\/fake-(app|api)\.js"/, rel);
      assert.ok(!src.includes("scripts/app.js\""), `${rel} must not import the real host`);
    }
  });

  test("index.html carries the sentinel devkit/server.py templates", () => {
    // devkit/server.py does a literal string replace; if the comment is edited the
    // page silently loses window.__DEV__ and boot.js throws on `.reload`.
    assert.ok(
      read("index.html").includes("<!-- __DEV_CONFIG__ : templated by scripts/devkit/server.py -->"),
      "the __DEV_CONFIG__ sentinel is gone; devkit/server.py can no longer inject window.__DEV__",
    );
  });

  test("index.html references only assets the dev server mounts", () => {
    const html = read("index.html");
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const url = m[1];
      if (!url.startsWith("/__dev/harness/")) continue;
      const rel = url.replace("/__dev/harness/", "harness/");
      assert.ok(fs.existsSync(path.join(DEVHARNESS, rel)), `index.html references missing ${url}`);
    }
  });

  test("nothing in devharness/ lives under web/", () => {
    // WEB_DIRECTORY = "./web": a stub there would be imported as an extension
    // on every real user's machine.
    assert.ok(!fs.existsSync(path.join(ROOT, "web", "scripts")), "a host stub leaked into web/");
  });

  test("the page entry is a module and is only loaded by index.html", () => {
    assert.match(read("index.html"), /<script type="module" src="\/__dev\/harness\/ui\.js">/);
    assert.match(read(PAGE_ENTRY), /^import /m, "ui.js should be an ES module");
  });
});

/* The word-picture generator, run against the fake host: the fake graph must
 * be a workflow the real template accepts, and the fake api must send the
 * events the real runner waits for. */
describe("devharness stands in for ComfyUI's queue", () => {
  const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
  let saved;

  before(() => {
    saved = { window: globalThis.window, fetch: globalThis.fetch };
    globalThis.window = { __DEV__: { apiPrefix: "/api" }, dispatchEvent() {} };
  });

  after(() => {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
  });

  test("graphToPrompt gives each Librarian node a workflow the generator accepts", async () => {
    const { app } = await imp("devharness/harness/fake-app.js");
    const T = await imp("web/prompt_librarian/word-pictures/template.js");
    app.__dev.addNode({ id: 41, comfyClass: "PromptLibrarian", widgets: [{ name: "text", value: "long prompt" }] });
    app.__dev.addNode({ id: 42, comfyClass: "PromptLibrarian", widgets: [{ name: "text", value: "other" }] });
    try {
      const { output } = await app.graphToPrompt();
      const prompt = T.wordPrompt(T.prepareTemplate(output, 42), "red fox");
      assert.equal(prompt["42"].inputs.text, "red fox");
      assert.equal(prompt["41"].inputs.text, "long prompt", "only the clicked node's text changes");
      assert.equal(prompt["42.7"].class_type, "PreviewImage", "SaveImage became a preview");
      assert.deepEqual(prompt["42.4"].inputs, { width: 320, height: 512, batch_size: 1 });
    } finally {
      for (const node of [...app.__dev.nodes]) app.__dev.removeNode(node);
    }
  });

  test("a queued prompt's outputs come back as ComfyUI's execution events", async () => {
    const { api } = await imp("devharness/harness/fake-api.js");
    const { render } = await imp("web/prompt_librarian/word-pictures/runner.js");
    const images = [{ filename: "dev_temp_00001_.png", subfolder: "", type: "temp" }];
    globalThis.fetch = async (url) => {
      assert.equal(url, "/api/prompt");
      return Response.json({ prompt_id: "dev-1", number: 1, __dev: { outputs: { 9: { images } } } });
    };
    const host = {
      async queue(prompt) {
        return (await api.fetchApi("/prompt", { method: "POST", body: JSON.stringify({ prompt }) })).json();
      },
      on(type, fn) {
        const listener = (event) => fn(event.detail);
        api.addEventListener(type, listener);
        return () => api.removeEventListener(type, listener);
      },
    };
    assert.deepEqual(await render(host, {}), images);
  });
});
