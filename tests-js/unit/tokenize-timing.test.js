/* ==========================================================================
   pickers/tokenize.js and shared/timing.js — both pure, both no-DOM.

   The tokenizer is deliberately aligned with prompt_librarian/wildcards.py: a
   highlight that disagrees with the resolver is worse than no highlight. These
   tests pin the grammar and the two documented divergences.
   ========================================================================== */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { imp, readWeb } from "../harness/mount.js";

const { tokenizeWildcards, TOK_CLASS } = await imp("prompt_librarian/pickers/tokenize.js");
const { debounce, rafThrottle } = await imp("prompt_librarian/shared/timing.js");

/** Compact view of a token list, for readable assertions. */
const shape = (text) =>
  tokenizeWildcards(text).map((t) => [t.kind, t.name, text.slice(t.start, t.end)]);

describe("tokenizeWildcards", () => {
  test("recognises all three forms with exact offsets", () => {
    const text = "a {red|blue} __hair/long__ [[intro]] end";
    const toks = tokenizeWildcards(text);
    assert.equal(toks.length, 3);
    for (const t of toks) {
      assert.equal(text.slice(t.start, t.end).length, t.end - t.start);
    }
    assert.deepEqual(shape(text), [
      ["brace", "red|blue", "{red|blue}"],
      ["file", "hair/long", "__hair/long__"],
      ["snippet", "intro", "[[intro]]"],
    ]);
  });

  test("returns tokens in source order", () => {
    const toks = tokenizeWildcards("[[a]] {b} __c__");
    assert.deepEqual(
      toks.map((t) => t.kind),
      ["snippet", "brace", "file"],
    );
    for (let i = 1; i < toks.length; i++) {
      assert.ok(toks[i].start >= toks[i - 1].end, "tokens must not overlap");
    }
  });

  test("nesting resolves to the INNERMOST brace", () => {
    // [^{}] cannot cross a brace, and the outer extent is ambiguous until the
    // resolver runs — so the honest highlight is the inner one.
    assert.deepEqual(shape("{a|{b|c}}"), [["brace", "b|c", "{b|c}"]]);
  });

  test("the file form is non-greedy, matching the backend", () => {
    // `__a____b__` is two wildcards, not one called "a____b".
    assert.deepEqual(
      tokenizeWildcards("__a____b__").map((t) => t.name),
      ["a", "b"],
    );
  });

  test("bracketed forms refuse to cross a newline", () => {
    // The one deliberate divergence from Python: a stray `{` would otherwise
    // paint the rest of the prompt as a choice. Under-highlighting is the safe
    // direction to be wrong in.
    assert.deepEqual(tokenizeWildcards("{a\nb}"), []);
    assert.deepEqual(tokenizeWildcards("[[a\nb]]"), []);
  });

  test("handles unicode names, where JS's ASCII \\w would not", () => {
    assert.deepEqual(
      tokenizeWildcards("__照明__").map((t) => t.name),
      ["照明"],
    );
  });

  test("trims a snippet name but not a brace's choices", () => {
    assert.equal(tokenizeWildcards("[[ intro ]]")[0].name, "intro");
    assert.equal(tokenizeWildcards("{ a | b }")[0].name, " a | b ");
  });

  test("adjacent tokens are both found", () => {
    assert.equal(tokenizeWildcards("{a}{b}").length, 2);
    assert.equal(tokenizeWildcards("[[a]][[b]]").length, 2);
  });

  test("an empty brace or snippet is still a token", () => {
    assert.deepEqual(shape("{}"), [["brace", "", "{}"]]);
    assert.deepEqual(shape("[[]]"), [["snippet", "", "[[]]"]]);
  });

  test("plain text and null-ish input yield nothing", () => {
    for (const v of ["", null, undefined, "a cat on a roof"]) {
      assert.deepEqual(tokenizeWildcards(v), []);
    }
  });

  test("a fresh regex per call — the same text twice gives the same answer", () => {
    // A module-level /g regex would carry lastIndex and skip tokens on the
    // second call. This is the regression that guards it.
    const text = "{a} {b} {c}";
    assert.deepEqual(tokenizeWildcards(text), tokenizeWildcards(text));
    assert.equal(tokenizeWildcards(text).length, 3);
  });

  test("the MAX_TOKENS guard caps the work and terminates", () => {
    const toks = tokenizeWildcards("{a}".repeat(5000));
    assert.ok(toks.length <= 4000, `expected the cap to hold, got ${toks.length}`);
    assert.ok(toks.length >= 3999, `expected the cap to be reached, got ${toks.length}`);
  });

  test("TOK_CLASS names classes librarian.css actually ships", () => {
    // Inventing a class name here produces silently unstyled spans in the
    // mirror — invisible in jsdom, which does not cascade, so it is checked
    // against the stylesheet text instead.
    assert.deepEqual(Object.keys(TOK_CLASS).sort(), ["brace", "file", "snippet"]);
    const css = readWeb("prompt_librarian/librarian.css");
    for (const cls of new Set(Object.values(TOK_CLASS))) {
      assert.ok(css.includes("." + cls), `librarian.css does not define .${cls}`);
    }
  });
});

describe("debounce", () => {
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  test("coalesces a burst into one trailing call with the last arguments", async () => {
    const seen = [];
    const d = debounce((v) => seen.push(v), 10);
    d(1);
    d(2);
    d(3);
    assert.deepEqual(seen, [], "nothing fires during the burst");
    await tick(30);
    assert.deepEqual(seen, [3], "last arguments win");
  });

  test("leading:true fires immediately and suppresses the trailing call", async () => {
    const seen = [];
    const d = debounce((v) => seen.push(v), 10, { leading: true });
    d("a");
    assert.deepEqual(seen, ["a"], "fires on the first call of a burst");
    d("b");
    await tick(30);
    assert.deepEqual(seen, ["a", "b"], "the burst's trailing call still lands once");
  });

  test("cancel() drops the pending call", async () => {
    const seen = [];
    const d = debounce((v) => seen.push(v), 10);
    d(1);
    assert.equal(d.pending(), true);
    d.cancel();
    assert.equal(d.pending(), false);
    await tick(30);
    assert.deepEqual(seen, [], "closeModal() relies on this to stop late writes");
  });

  test("flush() runs the pending call now and returns its value", async () => {
    const seen = [];
    const d = debounce((v) => {
      seen.push(v);
      return v * 2;
    }, 50);
    d(21);
    assert.equal(d.flush(), 42);
    assert.deepEqual(seen, [21]);
    assert.equal(d.pending(), false);
    await tick(70);
    assert.deepEqual(seen, [21], "and does not fire again afterwards");
  });

  test("cancel() and flush() are no-ops when nothing is pending", () => {
    const d = debounce(() => 1, 10);
    assert.doesNotThrow(() => d.cancel());
    assert.doesNotThrow(() => d.flush());
    assert.equal(d.pending(), false);
  });

  test("preserves `this`", async () => {
    const obj = {
      n: 0,
      bump: null,
    };
    obj.bump = debounce(function () {
      this.n++;
    }, 5);
    obj.bump();
    await tick(20);
    assert.equal(obj.n, 1);
  });
});

describe("rafThrottle", () => {
  test("collapses many calls per frame into one, last arguments winning", async () => {
    const seen = [];
    const t = rafThrottle((v) => seen.push(v));
    t(1);
    t(2);
    t(3);
    assert.deepEqual(seen, [], "nothing runs synchronously");
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, [3]);
  });

  test("cancel() prevents a queued frame from running", async () => {
    const seen = [];
    const t = rafThrottle((v) => seen.push(v));
    t(1);
    t.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, []);
  });

  test("falls back to a timer when requestAnimationFrame is absent", async () => {
    // The path taken in a headless/Node context — no globals installed here.
    assert.equal(typeof globalThis.requestAnimationFrame, "undefined");
    const seen = [];
    const t = rafThrottle(() => seen.push(1));
    t();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, [1]);
  });
});
