/* ==========================================================================
   The live duplicate panel, and what "keep both" is allowed to hide

   Muting used to be a one-way trapdoor. The panel dropped the pair, the badge
   subtracted it, and nothing anywhere could take the decision back — so a
   library with four copies of one prompt quietly reported one near-duplicate
   and offered no way to find out why.

   Now the panel LISTS a muted pair, marks it, and can un-mute it. The only
   thing the flag still changes is whether the save gate stops you, which is
   covered next door in dupe-gate.test.js.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { setupDom } from "../harness/env.js";
import { imp } from "../harness/mount.js";

const I = "prompt_librarian/inspector/";

let env;
beforeEach(() => {
  env = setupDom();
});
afterEach(() => {
  env.teardown();
});

function match(id, over = {}) {
  return { id, label: id + "_label", score: 0.97, summary: "a word", ignored: false, ...over };
}

/**
 * The duplicate panel on a real inspector view, driven by a hand-built pane.
 *
 * `buildView` is what owns `els.dupesPanel`, and the panel's rendering reads
 * half a dozen of its nodes, so faking those would be faking the thing under
 * test.
 */
async function makePanel(matches, over = {}) {
  const { resolveHelpers } = await imp(I + "helpers.js");
  const { buildView } = await imp(I + "view.js");
  const { createDupes } = await imp(I + "dupes.js");

  const calls = { ignorePair: [], dupes: 0, toasts: [] };
  let served = matches;

  const ctx = {
    ABORTED: Symbol("aborted"),
    API: {
      dupes: async () => {
        calls.dupes++;
        return { ok: true, matches: served };
      },
      ignorePair: async (a, b, unignore) => {
        calls.ignorePair.push([a, b, !!unignore]);
        if (over.unmuteFails) throw new Error("nope");
        served = served.map((m) => ({ ...m, ignored: false }));
        return { ok: true };
      },
    },
    setState: (patch) => Object.assign(state, patch),
  };

  const state = { dupes: { threshold: 0.9, matches, loading: false } };
  const el = document.createElement("div");
  document.body.appendChild(el);

  const pane = {
    ctx,
    el,
    calls,
    D: resolveHelpers(ctx),
    S: () => state,
    buf: { tags: [], body: "a body long enough to be checked at all" },
    current: over.current === undefined ? { id: "mine" } : over.current,
    disposed: false,
    dupeSeq: 0,
    dupePaused: false,
    lane: (_name, run) => run(null),
    toast: (m) => calls.toasts.push(String(m)),
    compareWith() {},
    mergeInto() {},
    openLocalPopover() {},
  };
  pane.els = buildView(pane).els ?? pane.els;
  createDupes(pane);
  pane.renderDupes();
  return pane;
}

/** Rows currently in the panel body. */
function rows(pane) {
  return [...pane.els.dupesBody.querySelectorAll(".pl-dupe")];
}

function button(el, label) {
  return [...el.querySelectorAll("button")].find((b) => b.textContent === label) || null;
}

describe("a muted pair is shown, not swallowed", () => {
  test("it still gets a row, marked", async () => {
    const pane = await makePanel([match("a", { ignored: true })]);
    const shown = rows(pane);

    assert.equal(shown.length, 1, "the duplicate did not stop existing");
    assert.equal(shown[0].classList.contains("is-muted"), true);
    assert.match(shown[0].textContent, /muted/);
  });

  test("the heading counts every match and says how many are settled", async () => {
    const pane = await makePanel([
      match("a", { ignored: true }),
      match("b", { ignored: true }),
      match("c"),
    ]);
    assert.match(pane.els.dupesTitle.textContent, /3 near matches/);
    assert.match(pane.els.dupesTitle.textContent, /2 muted/);
  });

  test("an all-muted panel drops the warning colours — it is not a warning", async () => {
    const pane = await makePanel([match("a", { ignored: true })]);
    assert.equal(pane.els.dupesPanel.style.background, "transparent");
    assert.equal(rows(pane)[0].classList.contains("is-top"), false);
  });

  test("one live match among muted ones keeps the panel amber", async () => {
    const pane = await makePanel([match("a", { ignored: true }), match("b")]);
    assert.equal(pane.els.dupesPanel.style.background, "");
  });

  test("an unmuted match is unchanged: no marking, no un-mute button", async () => {
    const pane = await makePanel([match("a")]);
    const row = rows(pane)[0];
    assert.equal(row.classList.contains("is-muted"), false);
    assert.equal(button(row, "un-mute"), null);
    assert.ok(button(row, "compare") && button(row, "merge"));
  });
});

describe("un-mute", () => {
  test("sends the pair back with the unignore flag and re-checks", async () => {
    const pane = await makePanel([match("a", { ignored: true })]);
    const before = pane.calls.dupes;

    button(rows(pane)[0], "un-mute").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(pane.calls.ignorePair, [["mine", "a", true]]);
    assert.ok(pane.calls.dupes > before, "the panel re-asks rather than guessing");
    assert.ok(pane.calls.toasts.some((t) => /un-muted/.test(t)));
  });

  test("the row loses its marking once the backend agrees", async () => {
    const pane = await makePanel([match("a", { ignored: true })]);
    button(rows(pane)[0], "un-mute").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(rows(pane)[0].classList.contains("is-muted"), false);
  });

  test("a failure says so and mutes nothing locally", async () => {
    const pane = await makePanel([match("a", { ignored: true })], { unmuteFails: true });
    button(rows(pane)[0], "un-mute").click();
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(pane.calls.toasts.some((t) => /could not un-mute/.test(t)));
    assert.equal(rows(pane)[0].classList.contains("is-muted"), true, "still muted on screen");
  });

  test("an unsaved draft has no pair to un-mute, and does not pretend otherwise", async () => {
    // Nothing is muted against a record that has no id yet, so the backend is
    // never called with a half-formed pair.
    const pane = await makePanel([match("a", { ignored: true })], { current: null });
    const btn = button(rows(pane)[0], "un-mute");
    if (btn) {
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
    }
    assert.deepEqual(pane.calls.ignorePair, []);
  });
});
