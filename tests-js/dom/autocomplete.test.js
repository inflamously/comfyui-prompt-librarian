import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { openShell, flush, deferred } from "../harness/modal.js";

let env, cleanup;
beforeEach(() => { env = setupDom(); cleanup = []; });
afterEach(() => { for (const fn of cleanup) fn(); env.teardown(); });
const item = (text, scope = "word") => ({ text, scope, source_count: 2 });

async function mount(api = async () => ({ suggestions: [item("volumetric"), item("volumetric lighting", "phrase")] })) {
  const { attachAutocomplete } = await imp("prompt_librarian/inspector/autocomplete.js");
  const host = document.createElement("div");
  const ta = document.createElement("textarea");
  host.appendChild(ta); document.body.appendChild(host);
  const calls = [];
  const ctx = { API: { autocomplete: (params, signal) => { calls.push({ params, signal }); return api(params, signal); } } };
  const ac = attachAutocomplete(ta, ctx, host);
  cleanup.push(() => ac.detach());
  const type = (value, pos = value.length) => {
    ta.focus(); ta.value = value; ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (key, options = {}) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
    ta.dispatchEvent(e); return e;
  };
  return { ta, host, ac, calls, ctx, type, key, menu: host.querySelector(".pl-autocomplete") };
}

test("requests immediately after two characters and accepts the selected phrase", async () => {
  const h = await mount();
  h.type("v");
  assert.equal(h.calls.length, 0);
  h.type("vo");
  assert.equal(h.calls.length, 1, "the request starts in the input event, without a timer");
  h.type("vol");
  assert.equal(h.calls.length, 2, "each edit requests its current prefix immediately");
  assert.equal(h.calls[0].signal.aborted, true);
  await flush();
  assert.equal(h.menu.hidden, false);
  assert.equal(h.ta.getAttribute("aria-expanded"), "true");
  assert.equal(h.menu.querySelector('[aria-selected="true"]').textContent, "volumetric");
  h.key("ArrowDown");
  assert.equal(h.key("Enter").defaultPrevented, true);
  assert.equal(h.ta.value, "volumetric lighting");
  assert.equal(document.activeElement, h.ta);
  assert.equal(h.menu.hidden, true);
  await flush(); assert.equal(h.calls.length, 2, "acceptance does not reopen suggestions");
});

test("caret replacement preserves separators, leading and trailing spaces", async () => {
  const h = await mount();
  h.type("before,  vol  , after", 12); await flush();
  h.menu.children[1].click();
  assert.equal(h.ta.value, "before,  volumetric lighting  , after");
  h.type("before, volxxxx, after", 11); await flush();
  assert.equal(h.calls.at(-1).params.phrase_prefix, "");
  assert.equal(h.menu.children.length, 1);
  h.key("Enter");
  assert.equal(h.ta.value, "before, volumetric, after");
});

test("stale results are cancelled even if transport ignores abort", async () => {
  const requests = [];
  const h = await mount(() => { const d = deferred(); requests.push(d); return d.promise; });
  h.type("vo"); await flush();
  h.type("vi"); assert.equal(h.calls[0].signal.aborted, true); await flush();
  requests[1].resolve({ suggestions: [item("violet")] }); await flush();
  requests[0].resolve({ suggestions: [item("volume")] }); await flush();
  assert.equal(h.menu.textContent, "violet");
  h.type("vo"); await flush(); h.ac.dismiss();
  requests[2].resolve({ suggestions: [item("volume")] }); await flush();
  assert.equal(h.menu.hidden, true);
});

test("Escape, Enter, selection, blur, IME and failures keep ordinary editing available", async () => {
  const h = await mount();
  h.type("vo"); await flush();
  assert.equal(h.key("Escape").defaultPrevented, true);
  assert.equal(h.menu.hidden, true);
  assert.equal(h.key("Tab").defaultPrevented, false);
  h.type("vo"); await flush();
  assert.equal(h.key("Enter", { shiftKey: true }).defaultPrevented, false);
  assert.equal(h.menu.hidden, true);
  assert.equal(h.ta.value, "vo");
  h.type("vo"); await flush();
  h.ta.setSelectionRange(0, 1); h.ta.dispatchEvent(new Event("select"));
  assert.equal(h.menu.hidden, true);
  h.ta.dispatchEvent(new Event("input")); await flush();
  const count = h.calls.length;
  h.ta.dispatchEvent(new Event("compositionstart"));
  h.type("vol"); await flush(); assert.equal(h.calls.length, count);
  h.ta.dispatchEvent(new Event("compositionend"));
  h.type("vo"); await flush(); h.ta.blur(); assert.equal(h.menu.hidden, true);
  h.ctx.API.autocomplete = async () => { throw Error("offline"); };
  h.type("vo"); await flush(); assert.equal(h.menu.hidden, true);
  assert.equal(h.key("Enter").defaultPrevented, false);
});

test("detach removes listeners and restores textarea attributes", async () => {
  const h = await mount();
  h.type("vo"); await flush(); h.ac.detach();
  h.type("vol"); await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.host.querySelector(".pl-autocomplete"), null);
  assert.equal(h.ta.hasAttribute("aria-autocomplete"), false);
});

test("suggestions render saved text literally", async () => {
  const h = await mount(async () => ({ suggestions: [item("<img src=x>", "phrase")] }));
  h.type("<i"); await flush();
  assert.equal(h.menu.textContent, "<img src=x>");
  assert.equal(h.menu.querySelector("img"), null);
});

test("real panel key bus isolates completion, Escape leaves panel open, input updates linked node", async () => {
  const shell = await openShell();
  const { onKey } = await imp("prompt_librarian/modal/input/keys.js");
  const { mountInspector } = await imp("prompt_librarian/inspector/index.js");
  const host = document.createElement("div"); shell.els.card.appendChild(host);
  const pushed = [], states = [];
  const ctx = {
    onKey, API: { autocomplete: async () => ({ suggestions: [item("volumetric")] }), dupes: async () => ({ matches: [] }) },
    setState: (patch) => states.push(patch), pushToNode: (body) => pushed.push(body),
    toast() {}, saveDraft() {},
  };
  const pane = mountInspector(host, ctx);
  cleanup.push(() => { pane.unmount(); shell.closeModal(); });
  const ta = host.querySelector("textarea");
  const type = () => { ta.focus(); ta.value = "vo"; ta.setSelectionRange(2, 2); ta.dispatchEvent(new Event("input", { bubbles: true })); };
  type();
  pane.setBody("vo", { fromNode: true });
  await flush(130);
  const menu = shell.root.querySelector(".pl-autocomplete");
  assert.equal(menu.parentNode, shell.root, "fixed menu escapes card containment");
  assert.equal(menu.hidden, false, "an echoed linked-node value must not cancel completion");
  shell.keyOn(ta, "Escape"); assert.equal(shell.it.open, true);
  type(); await flush(130);
  let canvasKeys = 0; document.addEventListener("keydown", () => canvasKeys++);
  assert.equal(shell.keyOn(ta, "Enter"), false); await flush(40);
  assert.equal(canvasKeys, 0);
  assert.equal(pane.getBuffer().body, "volumetric");
  assert.equal(pushed.at(-1), "volumetric");
  assert.equal(states.at(-1).buffer.body, "volumetric");
  type(); await flush(130);
  assert.equal(shell.keyOn(ta, "Enter", { shiftKey: true }), true, "Shift+Enter keeps the newline default");
  type(); await flush(130);
  pane.setBody("different record"); assert.equal(shell.root.querySelector(".pl-autocomplete").hidden, true);
});


test("pending requests preserve ordinary Escape and survive native caret scrolling", async () => {
  const h = await mount();
  h.type("vo");
  assert.equal(h.key("Escape").defaultPrevented, false);
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.menu.hidden, true);
  h.type("vol");
  h.ta.dispatchEvent(new Event("scroll"));
  await flush();
  assert.equal(h.menu.hidden, false);
  h.host.dispatchEvent(new Event("scroll"));
  assert.equal(h.menu.hidden, false);
});


test("dictionary completion rejects sentences returned by an older server", async () => {
  const h = await mount(async () => ({ suggestions: [
    item("volumetric lighting fills the entire room", "phrase"),
    item("volumetric lighting fills the entire room", "word"),
    item("volumetric"),
    item("volumetric lighting", "phrase"),
    item("volumetric golden lighting", "phrase"),
  ] }));
  h.type("vol");
  await flush();

  assert.deepEqual(Array.from(h.menu.children, (option) => option.textContent), [
    "volumetric", "volumetric lighting", "volumetric golden lighting",
  ]);
  h.key("ArrowDown");
  h.key("ArrowDown");
  h.key("Enter");
  assert.equal(h.ta.value, "volumetric golden lighting");
});


test("writing a long sentence keeps completion focused on the current word", async () => {
  const h = await mount();
  h.type("The light in the room is vol");
  assert.equal(h.calls[0].params.word_prefix, "vol");
  assert.equal(h.calls[0].params.phrase_prefix, "");
  await flush();

  assert.equal(h.menu.children.length, 1);
  h.key("Enter");
  assert.equal(h.ta.value, "The light in the room is volumetric");
});


test("Tab navigates normally and Enter inserts a newline when suggestions are dismissed", async () => {
  const h = await mount();
  for (const shiftKey of [false, true]) {
    h.type("vol");
    await flush();
    assert.equal(h.menu.hidden, false);
    assert.equal(h.key("Tab", { shiftKey }).defaultPrevented, false);
    assert.equal(h.menu.hidden, true);
    assert.equal(h.ta.value, "vol");
    assert.equal(h.key("Enter").defaultPrevented, false);
  }
});
