/* ==========================================================================
   Boot the pack the way ComfyUI does.

   ComfyUI scan-imports EVERY .js under WEB_DIRECTORY, then calls setup(), then
   creates nodes. Importing only the entry would be a friendlier harness and a
   worse one: "INERT ON IMPORT. Exports and const data only" is asserted at the
   top of nearly every module in this pack, and the whole-tree import is what
   enforces it. A module that quietly acquires an import-time side effect is a
   real regression class here.

   It also proves all 74 modules resolve in a BROWSER, whose ESM resolver
   differs from Node's on extensionless and query-suffixed specifiers.
   ========================================================================== */

import { app } from "./fake-app.js";
import { makeNode } from "./fake-node.js";

/**
 * Read the config LAZILY. `window.__DEV__` is written by an inline script that
 * devserver.py templates into <head>, and reading it at module scope would make
 * this file's correctness depend on script ordering — and unimportable anywhere
 * without a DOM, which is how tests-js/devharness.test.js checks it at all.
 */
const dev = () => window.__DEV__;
const out = (msg, cls = "") =>
  window.dispatchEvent(new CustomEvent("dev:log", { detail: { msg, cls } }));

/** Import every module under web/, in the order ComfyUI would. */
export async function loadPack({ bust = false } = {}) {
  const files = await (await fetch("/__dev/manifest")).json();
  // ComfyUI cache-busts extension URLs with ?v=…, which makes the module
  // registry key on the full URL — the exact hazard shared/singleton.js exists
  // for. Off by default; the "double-load" button turns it on.
  const q = bust ? "?v=" + Date.now() : "";
  let ok = 0;
  const failed = [];
  for (const rel of files) {
    try {
      await import(dev().mount + "/" + rel + q);
      ok++;
    } catch (err) {
      failed.push(rel);
      out(`import failed: ${rel} — ${err}`, "err");
    }
  }
  out(`imported ${ok}/${files.length} modules${bust ? " (cache-busted)" : ""}`, failed.length ? "err" : "ok");
  return { ok, failed };
}

export async function setupExtensions() {
  for (const ext of app._exts) {
    try {
      if (typeof ext.setup === "function") await ext.setup();
    } catch (err) {
      out(`${ext.name} setup() threw: ${err}`, "err");
    }
  }
  out(`setup() ran for ${app._exts.length} extension(s)`, "ok");
}

export function createNode(opts) {
  const node = makeNode(opts);
  app.__dev.addNode(node);
  document.getElementById("dev-canvas").appendChild(node.__el);
  for (const ext of app._exts) {
    try {
      if (typeof ext.nodeCreated === "function") ext.nodeCreated(node);
    } catch (err) {
      out(`${ext.name} nodeCreated() threw: ${err}`, "err");
    }
  }
  node.__render();
  out(`created node #${node.id} (${opts && opts.flavour ? opts.flavour : "legacy"})`, "ok");
  return node;
}

export function removeNode(node) {
  app.__dev.removeNode(node);
  node.__el.remove();
  out(`removed node #${node.id}`, "ok");
}

/* --------------------------------------------------------------------------
   Live reload — polling, deliberately, not SSE.

   The Python watcher re-execs the server process on a .py change. A stateless
   poll recovers from that with no reconnect semantics; an EventSource caught
   mid-exec is a lifecycle problem you would end up debugging instead of your
   own code. A FAILED fetch never reloads — only a CHANGED token does.
   -------------------------------------------------------------------------- */
export function watchForReload() {
  let seen = null;
  setInterval(async () => {
    let rev;
    try {
      rev = await (await fetch("/__dev/rev", { cache: "no-store" })).json();
    } catch {
      return; // server restarting; keep waiting
    }
    const token = `${rev.boot}:${rev.web}:${rev.py}`;
    if (seen === null) {
      seen = token;
      return;
    }
    if (token !== seen) location.reload();
  }, 500);
}
