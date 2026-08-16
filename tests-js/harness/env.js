/* ==========================================================================
   The jsdom environment

   Two things here are load-bearing and easy to get wrong:

   1. `url` is REQUIRED. Without it jsdom uses an opaque origin and
      `sessionStorage` throws SecurityError — which the inspector uses for
      per-record drafts, so half the pane dies on construction.

   2. `pretendToBeVisual: true` installs a real requestAnimationFrame loop,
      which KEEPS THE EVENT LOOP ALIVE. A test file that does not call
      `teardown()` hangs forever instead of failing. Always pair setupDom()
      with an afterEach/after that tears down.

   Do NOT copy `navigator` onto globalThis — it is a getter-only property on
   Node 22 and assigning it throws.
   ========================================================================== */

import { JSDOM } from "jsdom";
import { createApi } from "./net.js";
import { seedHost } from "./mount.js";

/**
 * Browser globals the pack reaches for. Deliberately does NOT include
 * `ResizeObserver`: jsdom has none, and its absence exercises the real
 * window-resize fallback in shell.js installResponsive().
 */
const GLOBALS = [
  "window",
  "document",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "Node",
  "HTMLElement",
  "DOMException",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "sessionStorage",
  "localStorage",
];

/**
 * Stand up a jsdom window, install the globals, capture console noise.
 *
 * @returns {{
 *   dom: JSDOM, window: Window, document: Document,
 *   app: object, api: object,
 *   errors: any[][], warns: any[][],
 *   expectError(re: RegExp): void,
 *   assertNoErrors(): void,
 *   reset(): void, teardown(): void,
 * }}
 */
export function setupDom({ url = "http://localhost:8188/" } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url,
  });

  const saved = new Map();
  for (const k of GLOBALS) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    globalThis[k] = k === "window" ? dom.window : dom.window[k];
  }

  const errors = [];
  const warns = [];
  const real = { error: console.error, warn: console.warn };
  console.error = (...a) => errors.push(a);
  console.warn = (...a) => warns.push(a);

  // The mount's scripts/*.js captured these objects on first evaluation and are
  // never re-evaluated, so the host must be MUTATED in place, never replaced.
  const host = seedHost();
  const api = createApi();
  Object.assign(host.api, api, { fetchApi: api.fetchApi.bind(api) });
  host.app._exts.length = 0;
  host.app.graph = { _nodes: [] };

  const expected = [];

  const env = {
    dom,
    window: dom.window,
    document: dom.window.document,
    app: host.app,
    api,
    errors,
    warns,

    /** Declare that one console.error matching `re` is expected in this test. */
    expectError(re) {
      expected.push(re);
    },

    /**
     * The check that catches what a happy-path DOM assertion walks straight
     * past: a ReferenceError logged and swallowed by one of the pack's many
     * defensive try/catch blocks.
     */
    assertNoErrors() {
      const unexpected = errors.filter(
        (a) => !expected.some((re) => re.test(a.map(String).join(" "))),
      );
      if (unexpected.length) {
        const lines = unexpected.map((a) => "  - " + a.map(String).join(" ")).join("\n");
        throw new Error(`unexpected console.error output:\n${lines}`);
      }
    },

    /** Between tests in one file: fresh singleton bag, fresh storage, no stubs. */
    reset() {
      delete dom.window.__PROMPT_LIBRARIAN__;
      delete globalThis.__PROMPT_LIBRARIAN__;
      try {
        dom.window.sessionStorage.clear();
        dom.window.localStorage.clear();
      } catch {
        /* storage disabled */
      }
      dom.window.document.body.innerHTML = "";
      errors.length = 0;
      warns.length = 0;
      expected.length = 0;
      api.reset();
      host.app._exts.length = 0;
      host.app.graph = { _nodes: [] };
    },

    teardown() {
      console.error = real.error;
      console.warn = real.warn;
      for (const [k, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
      // Stops the rAF loop; without this the test file never exits.
      dom.window.close();
    },
  };
  return env;
}
