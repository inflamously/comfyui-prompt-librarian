/* ==========================================================================
   Tier 0 — structure

   The cheapest tests in the suite and the ones that catch the class of bug
   nothing else can: a moved file, a renamed export, an import-time side effect,
   a stray `fetch`. No jsdom except the last block, no network, ~1 s.

   Everything here goes through the mirrored mount (harness/mount.js), so the
   hardcoded `../` depths are exercised rather than bypassed.
   ========================================================================== */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { allModules, imp, readWeb, ROOT, scriptUrl, seedHost, url, WEB } from "./harness/mount.js";

/** The two entry files are the only ones allowed side effects on import. */
const ENTRIES = ["prompt_librarian/index.js", "prompt_store/index.js"];

/**
 * The only two module-level `singleton()` calls in the tree
 * (api/lanes.js:89, api/caps.js:18) — the documented exceptions to
 * "INERT ON IMPORT", and the two bindings that survive a bag reset.
 */
const ALLOWED_BAG_KEYS = ["caps", "lanes"];

/** The four files allowed to import ComfyUI's core tree, and what they walk to. */
const HOST_IMPORTERS = {
  "prompt_librarian/index.js": "../../../scripts/app.js",
  "prompt_librarian/api/request.js": "../../../../scripts/api.js",
  "prompt_store/index.js": "../../../scripts/app.js",
  "prompt_store/api.js": "../../../scripts/api.js",
};

describe("tier 0 — structure", () => {
  test("every module under web/ imports cleanly through the mount", async () => {
    // A missing named export or a wrong ../ depth is a link-time error, so this
    // one loop validates every path and every re-export in the tree.
    seedHost();
    const mods = allModules();
    assert.ok(mods.length > 50, `expected a populated tree, found ${mods.length} modules`);

    const failures = [];
    for (const rel of mods) {
      try {
        await imp(rel);
      } catch (err) {
        failures.push(`${rel}\n    ${String(err).split("\n")[0]}`);
      }
    }
    assert.deepEqual(failures, [], `modules failed to import:\n  ${failures.join("\n  ")}`);
  });

  test("INERT ON IMPORT — no module but the entries does work at load time", async () => {
    // The invariant nearly every file in this tree asserts in its header, as a
    // runtime check rather than a comment. Imported with no DOM at all: a module
    // that touches document/window on load throws instead of silently working
    // because an earlier test happened to set up jsdom.
    const hadDoc = "document" in globalThis;
    const hadWin = "window" in globalThis;
    assert.ok(!hadDoc && !hadWin, "this test must run before any jsdom is installed");

    seedHost();
    delete globalThis.__PROMPT_LIBRARIAN__;

    const failures = [];
    for (const rel of allModules()) {
      if (ENTRIES.includes(rel)) continue;
      try {
        await imp(rel, { fresh: true });
      } catch (err) {
        failures.push(`${rel}\n    ${String(err).split("\n")[0]}`);
      }
    }
    assert.deepEqual(failures, [], `modules did work on import:\n  ${failures.join("\n  ")}`);

    // With no `window`, singleton() falls back to globalThis.
    const bag = globalThis.__PROMPT_LIBRARIAN__ ?? {};
    assert.deepEqual(
      Object.keys(bag).sort(),
      ALLOWED_BAG_KEYS,
      "a new module-level singleton() appeared; it will survive a test reset",
    );
  });

  test("the ../ walks out of web/ land exactly on the host stubs", () => {
    // Pure path math against the mount, so a break names the offending file
    // instead of failing 74 imports at once. THIS is the test that catches
    // someone moving request.js one directory deeper.
    for (const [rel, specifier] of Object.entries(HOST_IMPORTERS)) {
      const resolved = new URL(specifier, url(rel)).href;
      const want = scriptUrl(path.posix.basename(specifier));
      assert.equal(resolved, want, `${rel} resolves ${specifier} to the wrong place`);
    }
  });

  test("the declared host importers are the only ones, and they still declare it", () => {
    const found = [];
    for (const rel of allModules()) {
      if (/\.\.\/.*scripts\/(app|api)\.js/.test(readWeb(rel))) found.push(rel);
    }
    assert.deepEqual(
      found.sort(),
      Object.keys(HOST_IMPORTERS).sort(),
      "the set of files coupled to ComfyUI's core tree changed",
    );
  });

  test("the two domains stay independent", () => {
    // Deleting either domain directory must leave the other working — the
    // invariant web/prompt_librarian/index.js documents in its header.
    for (const rel of allModules()) {
      const src = readWeb(rel);
      if (rel.startsWith("prompt_librarian/")) {
        assert.ok(!/from\s+["'][^"']*prompt_store\//.test(src), `${rel} imports prompt_store/`);
      }
      if (rel.startsWith("prompt_store/")) {
        assert.ok(
          !/from\s+["'][^"']*prompt_librarian\//.test(src),
          `${rel} imports prompt_librarian/`,
        );
      }
    }
  });

  test("api.fetchApi is the only network call site", () => {
    // request.js explains why: bare fetch() works on a default install and
    // 404s behind a reverse proxy, which is the kind of bug that only shows up
    // on somebody else's machine.
    const offenders = [];
    for (const rel of allModules()) {
      if (rel === "prompt_librarian/api/request.js" || rel === "prompt_store/api.js") continue;
      const src = readWeb(rel);
      for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /sendBeacon/]) {
        if (pattern.test(src)) offenders.push(`${rel} (${pattern})`);
      }
    }
    assert.deepEqual(offenders, [], "network I/O outside the transport modules");
  });

  test("the in-flight removal of the dirty bar left no .pl-dirty behind", () => {
    // jsdom does not cascade, so CSS is never worth a DOM assertion — but a
    // grep for a class that should no longer exist is exact and free.
    const stale = [];
    for (const rel of allModules()) {
      if (readWeb(rel).includes("pl-dirty")) stale.push(rel);
    }
    if (fs.readFileSync(path.join(WEB, "prompt_librarian/librarian.css"), "utf8").includes("pl-dirty")) {
      stale.push("prompt_librarian/librarian.css");
    }
    assert.deepEqual(stale, [], "`pl-dirty` survived the save-on-close rewrite");
  });

  test("tests-js lives outside web/, so ComfyUI never imports it", () => {
    // WEB_DIRECTORY = "./web" means ComfyUI imports EVERY .js beneath it as an
    // extension. A test file there would run in every user's browser, where
    // node:test and jsdom do not exist.
    for (const rel of allModules()) {
      assert.ok(!/\.test\.js$/.test(rel), `${rel} is a test file inside web/`);
      assert.ok(!/^tests/.test(rel), `${rel} looks like test scaffolding inside web/`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, "tests-js")), "tests-js/ should be at the pack root");
  });
});

test("prompt_modal replaces every production modal path without a compatibility shim", () => {
  assert.equal(fs.existsSync(path.join(WEB, "prompt_librarian", "modal")), false);
  const oldPath = /(?:^|[^\w])modal\//;
  for (const rel of allModules()) assert.equal(oldPath.test(readWeb(rel)), false, rel);
  const diagram = fs.readFileSync(path.join(ROOT, "structure.html"), "utf8");
  const source = JSON.parse(diagram.match(/<script id="source-data" type="application\/json">(.*?)<\/script>/s)[1]);
  const files = source.files.modal;
  assert.deepEqual(files, allModules().filter(p => p.startsWith("prompt_librarian/prompt_modal/")).map(p => "web/" + p));
  for (const edge of source.edges) {
    if (edge.source.startsWith("web/")) {
      assert.ok(fs.existsSync(path.join(ROOT, edge.source)), edge.source);
      assert.ok(fs.existsSync(path.join(ROOT, edge.target)), edge.target);
    }
  }
});
