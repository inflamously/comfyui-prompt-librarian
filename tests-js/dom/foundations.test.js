/* ==========================================================================
   shared/component.js, shared/styles.js and shared/keys.js — the building
   blocks every migrated component stands on.
   ========================================================================== */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

let env;
beforeEach(() => { env = setupDom(); });
afterEach(() => { env.assertNoErrors(); env.teardown(); });

const { Component } = await imp("prompt_librarian/shared/component.js");
const { Store } = await imp("prompt_librarian/shared/store.js");
const { useStyles, ensureStyles } = await imp("prompt_librarian/shared/styles.js");
const { installKeyGuards, onKey } = await imp("prompt_librarian/shared/keys.js");

class Counter extends Component {
  render() {
    const el = document.createElement("button");
    this.listen(el, "click", () => this.deps.slice.set({ n: this.deps.slice.get("n") + 1 }));
    this.watch(this.deps.slice, "n", (n) => { el.textContent = String(n); });
    return el;
  }
}

test("a component mounts, reacts to its slice and releases everything on destroy", () => {
  const slice = new Store({ c: { n: 0 } }).slice("c");
  const counter = new Counter({ slice }).mount(document.body);
  counter.el.click();
  assert.equal(document.body.textContent, "1");

  const el = counter.el;
  counter.destroy();
  assert.equal(el.isConnected, false);
  el.click();
  assert.equal(slice.get("n"), 1, "the click listener is gone");
  slice.set({ n: 5 });
  assert.equal(el.textContent, "1", "the subscription is gone");
  assert.doesNotThrow(() => counter.destroy(), "destroy is idempotent");
});

test("own() destroys children and runs cleanups, last registered first", () => {
  const order = [];
  class Leaf extends Component {
    render() { return document.createElement("i"); }
    destroy() { order.push(this.deps.name); super.destroy(); }
  }
  class Parent extends Component {
    render() {
      const el = document.createElement("div");
      this.own(new Leaf({ name: "a" })).mount(el);
      this.own(() => order.push("fn"));
      this.own(new Leaf({ name: "b" })).mount(el);
      return el;
    }
  }
  new Parent().mount(document.body).destroy();
  assert.deepEqual(order, ["b", "fn", "a"]);
});

test("render() must be implemented and mount() runs once", () => {
  assert.throws(() => new Component().mount(document.body), /render\(\) not implemented/);
  const c = new Counter({ slice: new Store({ c: { n: 0 } }).slice("c") }).mount(document.body);
  assert.throws(() => c.mount(document.body), /already mounted/);
  c.destroy();
});

test("useStyles links each file once, ignoring the cache-busting query", () => {
  const a = useStyles("http://localhost:8188/extensions/x/rail.css?v=1");
  const b = useStyles(new URL("http://localhost:8188/extensions/x/rail.css?v=2"));
  assert.equal(a, b);
  assert.equal(document.querySelectorAll("link[rel=stylesheet]").length, 1);
});

test("ensureStyles links tokens first and the shared/ui sheets after it, each once", () => {
  ensureStyles();
  ensureStyles();
  const names = [...document.querySelectorAll("link[rel=stylesheet]")].map((l) =>
    new URL(l.href).pathname.split("/prompt_librarian/")[1]);
  assert.equal(names[0], "shared/ui/tokens.css");
  assert.equal(names.at(-1), "shared/ui/button.css");
  assert.ok(names.every((n) => n.startsWith("shared/ui/")), names.join());
  assert.equal(new Set(names).size, names.length);
});

test("installKeyGuards returns an uninstall that frees the host's shortcuts", () => {
  const root = document.createElement("div");
  const input = document.createElement("input");
  root.append(input);
  document.body.append(root);

  const bus = [];
  const host = [];
  onKey(input, "keydown", (e) => bus.push(e.key));
  window.addEventListener("keydown", (e) => host.push(e.key));

  const uninstall = installKeyGuards(root);
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  assert.deepEqual([bus, host], [["a"], []], "guarded: the bus gets it, the host does not");

  uninstall();
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", bubbles: true }));
  assert.deepEqual(host, ["b"], "unguarded: the host sees keys again");
});
