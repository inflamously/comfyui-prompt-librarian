/* ==========================================================================
   features/dupes: the live panel, the revise dialog and the threshold

   The panel is a signal and `revise` is the workbench. The inline panel used to
   list every match, which made a routine near-miss look like a wall of
   decisions inside the editor. It is now a heading (count, muted count,
   threshold) and nothing else; every match is listed behind `revise`.

   Muting used to be a one-way trapdoor: the panel dropped the pair and nothing
   could take the decision back. A muted pair is now LISTED, marked, and can be
   un-muted. The only thing the flag still changes is whether the save gate
   stops you (dupe-gate.test.js).
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";
import { flush } from "../harness/modal.js";

const { DupesPanel } = await imp("prompt_librarian/features/dupes/index.js");
const { Store } = await imp("prompt_librarian/shared/store.js");
const { LayerStack } = await imp("prompt_librarian/shared/ui/layer-stack.js");
const { installKeyGuards } = await imp("prompt_librarian/shared/keys.js");

let env;
beforeEach(() => { env = setupDom(); });
afterEach(() => { env.assertNoErrors(); env.teardown(); });

function match(id, over = {}) {
  return { id, label: id + "_label", score: 0.97, summary: "a word", ignored: false, ...over };
}

async function makePanel(matches, over = {}) {
  const host = document.createElement("div");
  const el = document.createElement("div");
  document.body.append(host, el);
  const layers = new LayerStack(host);
  const slice = new Store({ dupes: { threshold: 0.9, matches, loading: false } }).slice("dupes");
  const calls = { ignorePair: [], dupes: 0, toasts: [], settings: [], refreshed: 0, compared: [] };
  let served = matches;
  let mine = over.current === undefined ? { id: "mine" } : over.current;

  const panel = new DupesPanel({
    api: {
      dupes: async () => { calls.dupes++; return { ok: true, matches: served }; },
      ignorePair: async (a, b, unignore) => {
        calls.ignorePair.push([a, b, !!unignore]);
        if (over.unmuteFails) throw new Error("nope");
        served = served.map((m) => ({ ...m, ignored: false }));
        return { ok: true };
      },
      settings: async (patch) => { calls.settings.push(patch); return { ok: true }; },
    },
    slice,
    lane: (run) => run(null),
    layers: () => layers,
    toast: (m) => calls.toasts.push(String(m)),
    subject: () => ({ body: "a body long enough to be checked at all", id: mine ? mine.id : null, label: mine ? mine.id : "" }),
    onCompare: (m) => calls.compared.push(m.id),
    onMerge() {},
    onOverwrite() {},
    onThreshold: () => { calls.refreshed++; },
  }).mount(el);
  return { panel, slice, layers, calls, setCurrent: (v) => { mine = v; } };
}

/** The rows `revise` lists, from a freshly opened dialog. */
function rows(t) {
  t.panel.reviseBtn.click();
  return [...(t.layers.top()?.el.querySelectorAll(".pl-dupe") ?? [])];
}

const button = (el, label) => [...el.querySelectorAll("button")].find((b) => b.textContent === label) || null;

describe("the inline panel", () => {
  test("is a heading and nothing else — no match is listed inline", async () => {
    const { panel } = await makePanel([match("a"), match("b"), match("c")]);
    assert.equal(panel.body.textContent, "", "the body stays empty");
    assert.doesNotMatch(panel.panel.textContent, /a_label/, "not even the closest one");
    assert.match(panel.title.textContent, /3 near matches/, "the count is in the heading");
  });

  test("`revise` appears only when there is something to revise", async () => {
    assert.equal((await makePanel([match("a")])).panel.reviseBtn.hidden, false);
    assert.equal((await makePanel([])).panel.reviseBtn.hidden, true);
  });

  test("the heading counts every match and says how many are settled", async () => {
    const { panel } = await makePanel([match("a", { ignored: true }), match("b", { ignored: true }), match("c")]);
    assert.match(panel.title.textContent, /3 near matches/);
    assert.match(panel.title.textContent, /2 muted/);
  });

  test("an all-muted panel drops the warning colours; one live match keeps them", async () => {
    const quiet = await makePanel([match("a", { ignored: true })]);
    assert.equal(quiet.panel.panel.style.background, "transparent");
    assert.equal(rows(quiet)[0].classList.contains("is-top"), false);
    const amber = await makePanel([match("a", { ignored: true }), match("b")]);
    assert.equal(amber.panel.panel.style.background, "");
  });

  test("a long body pauses the live check until asked", async () => {
    const t = await makePanel([]);
    t.panel.deps.subject = () => ({ body: "x".repeat(8001), id: null });
    await t.panel.check();
    assert.equal(t.calls.dupes, 0);
    assert.match(t.panel.title.textContent, /paused/);
    button(t.panel.body, "check now").click();
    await flush();
    assert.equal(t.calls.dupes, 1);
  });
});

describe("the revise dialog", () => {
  test("lists every match, muted ones marked", async () => {
    const t = await makePanel([match("a"), match("b", { ignored: true }), match("c")]);
    const shown = rows(t);
    assert.equal(shown.length, 3);
    assert.equal(shown[1].classList.contains("is-muted"), true);
    assert.match(shown[1].textContent, /muted/);
    assert.equal(button(shown[0], "un-mute"), null, "an unmuted match has no un-mute button");
    assert.ok(button(shown[0], "compare") && button(shown[0], "merge"));
  });

  test("each row says what survives and what is thrown away", async () => {
    const row = rows(await makePanel([match("a")]))[0];
    assert.match(row.textContent, /merge keeps .*a_label.* \(id, usage, history\)/);
    assert.match(row.textContent, /throws away/, "the cost of merging is named, not implied");
    assert.match(row.textContent, /overwrite keeps both records/);
  });

  test("an unsaved draft has nothing to throw away, and does not claim it does", async () => {
    const t = await makePanel([match("a")]);
    t.setCurrent(null);
    const mergeLine = [...rows(t)[0].querySelectorAll(".pl-dupe-why")].find((n) => /^merge keeps/.test(n.textContent));
    assert.match(mergeLine.textContent, /nothing else is created/);
    assert.doesNotMatch(mergeLine.textContent, /throws away/);
  });

  test("acting on a row closes the dialog it was launched from", async () => {
    const t = await makePanel([match("a"), match("b")]);
    button(rows(t)[0], "compare").click();
    assert.deepEqual(t.calls.compared, ["a"]);
    assert.equal(t.layers.size, 0, "compare takes the screen; this must not stay under it");
  });
});

describe("un-mute", () => {
  test("sends the pair back with the unignore flag, re-checks, and the marking goes", async () => {
    const t = await makePanel([match("a", { ignored: true })]);
    const before = t.calls.dupes;
    button(rows(t)[0], "un-mute").click();
    await flush();
    assert.deepEqual(t.calls.ignorePair, [["mine", "a", true]]);
    assert.ok(t.calls.dupes > before, "the panel re-asks rather than guessing");
    assert.ok(t.calls.toasts.some((m) => /un-muted/.test(m)));
    assert.equal(rows(t)[0].classList.contains("is-muted"), false);
  });

  test("a failure says so and mutes nothing locally", async () => {
    const t = await makePanel([match("a", { ignored: true })], { unmuteFails: true });
    button(rows(t)[0], "un-mute").click();
    await flush();
    assert.ok(t.calls.toasts.some((m) => /could not un-mute/.test(m)));
    assert.equal(rows(t)[0].classList.contains("is-muted"), true, "still muted on screen");
  });

  test("an unsaved draft has no pair to un-mute, and does not pretend otherwise", async () => {
    const t = await makePanel([match("a", { ignored: true })], { current: null });
    button(rows(t)[0], "un-mute").click();
    await flush();
    assert.deepEqual(t.calls.ignorePair, []);
  });
});

describe("the threshold", () => {
  test("is used at once, persisted, and the list is re-asked too", async () => {
    const t = await makePanel([match("a")]);
    t.panel.threshBtn.click();
    const option = [...t.layers.top().el.querySelectorAll(".pl-opt")].find((b) => b.textContent.includes("80%"));
    option.click();
    await flush();
    assert.equal(t.slice.get("threshold"), 0.8, "the panel uses it now");
    assert.match(t.panel.threshBtn.textContent, /80%/);
    assert.deepEqual(t.calls.settings, [{ dupe_threshold: 0.8 }], "and it survives a reopen");
    assert.ok(t.calls.refreshed > 0, "the list's duplicate counts agree with the panel");
    assert.equal(t.layers.size, 0, "the picker closed");
  });

  test("the picker focuses the current value and takes arrows and Enter through the key bus", async () => {
    const t = await makePanel([match("a")]);
    const uninstall = installKeyGuards(document.body);
    t.panel.threshBtn.click();
    assert.match(document.activeElement.textContent, /90%/, "focus starts on the current value");
    const press = (key) => document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    press("ArrowDown");
    press("Enter");
    await flush();
    uninstall();
    assert.equal(t.slice.get("threshold"), 0.95);
  });

  test("a stale answer never overwrites a fresher one", async () => {
    const t = await makePanel([]);
    let release;
    t.panel.deps.api.dupes = () => new Promise((r) => { release = r; });
    const slow = t.panel.check();
    t.panel.clear();
    release({ ok: true, matches: [match("late")] });
    await slow;
    assert.deepEqual(t.slice.get("matches"), []);
  });
});
