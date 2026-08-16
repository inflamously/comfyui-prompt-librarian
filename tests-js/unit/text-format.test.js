/* ==========================================================================
   shared/text.js and shared/format.js

   All pure, no DOM. `relTime` takes `now` as a parameter, so nothing here
   mocks a clock.
   ========================================================================== */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const T = await imp("prompt_librarian/shared/text.js");
const F = await imp("prompt_librarian/shared/format.js");

/** A ZWJ family emoji: 7 code points, 11 UTF-16 units, 1 grapheme. */
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}";
/** A single astral code point: 2 UTF-16 units. */
const CLAPPER = "\u{1F3AC}";

describe("graphemes / charCount", () => {
  test("never splits a surrogate pair", () => {
    // The whole reason this exists instead of str.split("").
    assert.deepEqual(T.graphemes(CLAPPER), [CLAPPER]);
    assert.equal(T.charCount(CLAPPER), 1);
    assert.equal(CLAPPER.length, 2, "…which .length would have got wrong");
  });

  test("counts a ZWJ sequence as one user-perceived character", () => {
    // True only with Intl.Segmenter; the Array.from fallback sees code points.
    const hasSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
    if (hasSegmenter) {
      assert.deepEqual(T.graphemes(FAMILY), [FAMILY]);
      assert.equal(T.charCount(FAMILY), 1);
    } else {
      assert.equal(T.charCount(FAMILY), 5, "code-point fallback");
    }
  });

  test("the Array.from fallback is reachable and still never splits a pair", async () => {
    // Probe the branch a ComfyUI running in an engine without Intl.Segmenter
    // would take. A fresh module instance is required: SEGMENTER is resolved
    // once at module scope.
    const real = Intl.Segmenter;
    try {
      // eslint-disable-next-line no-global-assign
      Intl.Segmenter = undefined;
      const T2 = await imp("prompt_librarian/shared/text.js", { fresh: true });
      assert.deepEqual(T2.graphemes(CLAPPER), [CLAPPER], "fallback kept the pair whole");
      assert.equal(T2.charCount(CLAPPER), 1);
      assert.equal(T2.charCount("abc"), 3);
      assert.equal(T2.truncate("abcdef", 3), "abc…");
    } finally {
      Intl.Segmenter = real;
    }
  });

  test("empty and null in, empty out", () => {
    for (const v of [null, undefined, ""]) {
      assert.deepEqual(T.graphemes(v), []);
      assert.equal(T.charCount(v), 0);
    }
  });
});

describe("truncate", () => {
  test("only appends an ellipsis when it actually cut", () => {
    assert.equal(T.truncate("abc", 5), "abc");
    assert.equal(T.truncate("abc", 3), "abc", "exactly at the cap is not a cut");
    assert.equal(T.truncate("abcdef", 3), "abc…");
  });

  test("cuts on grapheme units, not UTF-16 units", () => {
    const s = CLAPPER + CLAPPER + CLAPPER;
    assert.equal(T.truncate(s, 2), CLAPPER + CLAPPER + "…");
    // The failure mode being guarded against is a LONE surrogate at the cut —
    // a well-formed string may of course end inside no pair at all.
    for (const n of [1, 2, 3]) {
      assert.ok(T.truncate(s, n).isWellFormed(), `truncate(s, ${n}) split a surrogate pair`);
    }
  });

  test("a non-positive cap yields an empty string", () => {
    assert.equal(T.truncate("abc", 0), "");
    assert.equal(T.truncate("abc", -1), "");
  });

  test("the ellipsis is overridable", () => {
    assert.equal(T.truncate("abcdef", 3, "..."), "abc...");
  });
});

describe("firstLine", () => {
  test("collapses all whitespace to single spaces and trims", () => {
    assert.equal(T.firstLine("  a\n\nb\t c  "), "a b c");
    assert.equal(T.firstLine("one\ntwo"), "one two");
  });

  test("applies the cap only when given one", () => {
    assert.equal(T.firstLine("aaaa bbbb"), "aaaa bbbb");
    assert.equal(T.firstLine("aaaa bbbb", 4), "aaaa…");
  });

  test("null-ish in, empty out", () => {
    assert.equal(T.firstLine(null), "");
    assert.equal(T.firstLine(undefined), "");
  });
});

describe("headLabel", () => {
  test("returns a short body unchanged", () => {
    assert.equal(T.headLabel("a dancer in the rain"), "a dancer in the rain");
  });

  test("returns empty for an empty body — the caller owns the placeholder", () => {
    assert.equal(T.headLabel(""), "");
    assert.equal(T.headLabel("   \n  "), "");
    assert.equal(T.headLabel(null), "");
  });

  test("cuts on a word boundary and strips trailing punctuation", () => {
    const body = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const out = T.headLabel(body, 20);
    assert.ok(out.endsWith("…"), out);
    assert.ok(!/[ ,;:.\-]…$/.test(out), `trailing punctuation was not stripped: ${out}`);
    assert.ok(out.length <= 21, out);
    assert.ok(body.startsWith(out.slice(0, -1)), "the head must be a prefix of the body");
  });

  test("falls back to a hard cut when there is no space to cut on", () => {
    // lastIndexOf(" ") < n/2 means honouring the word boundary would throw
    // away more than half the label.
    const out = T.headLabel("a " + "x".repeat(80), 20);
    assert.ok(out.endsWith("…"));
    assert.ok(out.length > 11, `expected a hard cut, got ${out}`);
  });

  test("collapses newlines before measuring", () => {
    assert.equal(T.headLabel("one\ntwo"), "one two");
  });
});

describe("labelOf", () => {
  test("prefers the backend's derived label", () => {
    assert.equal(T.labelOf({ label: "corpus label", body: "some body" }), "corpus label");
  });

  test("falls back to the body head, then the preview", () => {
    assert.equal(T.labelOf({ body: "a dancer" }), "a dancer");
    assert.equal(T.labelOf({ preview: "a preview" }), "a preview");
    assert.equal(T.labelOf({ label: "   " }), "", "a blank label is not a label");
  });

  test("accepts a bare string so an unsaved body can be labelled", () => {
    assert.equal(T.labelOf("a dancer in the rain"), "a dancer in the rain");
  });

  test("truncates a long given label to the cap", () => {
    const long = "z".repeat(100);
    assert.equal(T.labelOf({ label: long }, 10), "z".repeat(10) + "…");
  });

  test("null-ish in, empty out", () => {
    assert.equal(T.labelOf(null), "");
    assert.equal(T.labelOf(undefined), "");
    assert.equal(T.labelOf({}), "");
  });
});

describe("estimateTokens", () => {
  test("is zero for nothing", () => {
    assert.equal(T.estimateTokens(""), 0);
    assert.equal(T.estimateTokens("   \n "), 0);
    assert.equal(T.estimateTokens(null), 0);
  });

  test("counts roughly one token per short word", () => {
    assert.equal(T.estimateTokens("a cat sat"), 3);
  });

  test("charges long words extra", () => {
    assert.ok(
      T.estimateTokens("extraordinarily") > T.estimateTokens("short"),
      "a long word should cost more than one token",
    );
  });

  test("grows monotonically as text is added", () => {
    let prev = 0;
    for (const s of ["a", "a b", "a b c", "a b c dddddddddddd"]) {
      const n = T.estimateTokens(s);
      assert.ok(n >= prev, `${s} -> ${n} went backwards from ${prev}`);
      prev = n;
    }
  });

  test("counts CJK per character, since it has no spaces", () => {
    assert.equal(T.estimateTokens("猫"), 1);
    assert.equal(T.estimateTokens("猫犬鳥"), 3);
  });

  test("collapses long punctuation runs rather than charging per mark", () => {
    assert.ok(T.estimateTokens("hi........") <= T.estimateTokens("hi") + 3);
  });
});

describe("stars", () => {
  test("renders filled then hollow, always `max` glyphs wide", () => {
    assert.equal(T.stars(0), T.STAR_EMPTY.repeat(5));
    assert.equal(T.stars(5), T.STAR_FULL.repeat(5));
    assert.equal(T.stars(3), T.STAR_FULL.repeat(3) + T.STAR_EMPTY.repeat(2));
    for (const r of [0, 1, 2, 3, 4, 5]) assert.equal(T.stars(r).length, 5);
  });

  test("clamps and rounds", () => {
    assert.equal(T.stars(9), T.stars(5));
    assert.equal(T.stars(-3), T.stars(0));
    assert.equal(T.stars(2.4), T.stars(2));
    assert.equal(T.stars(2.6), T.stars(3));
    assert.equal(T.stars(null), T.stars(0));
    assert.equal(T.stars("abc"), T.stars(0));
  });

  test("honours a different max", () => {
    assert.equal(T.stars(1, 3), T.STAR_FULL + T.STAR_EMPTY.repeat(2));
  });

  test("uses text glyphs, never an icon font", () => {
    assert.equal(T.STAR_FULL, "★");
    assert.equal(T.STAR_EMPTY, "☆");
  });
});

describe("relTime", () => {
  const now = Date.parse("2026-08-16T12:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  const S = 1000;
  const MIN = 60 * S;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  test("walks the whole ladder", () => {
    assert.equal(F.relTime(ago(0), now), "just now");
    assert.equal(F.relTime(ago(44 * S), now), "just now");
    assert.equal(F.relTime(ago(5 * MIN), now), "5m");
    assert.equal(F.relTime(ago(3 * HOUR), now), "3h");
    assert.equal(F.relTime(ago(2 * DAY), now), "2d");
    assert.equal(F.relTime(ago(6 * DAY), now), "6d");
  });

  test("switches to an absolute date past a week, and adds the year past ~11 months", () => {
    assert.match(F.relTime(ago(30 * DAY), now), /^[A-Z][a-z]{2} \d{1,2}$/);
    assert.match(F.relTime(ago(400 * DAY), now), /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  test("a future timestamp reads as just now rather than a negative", () => {
    // Server/browser clock skew must never render "-3m".
    assert.equal(F.relTime(new Date(now + 60 * MIN).toISOString(), now), "just now");
  });

  test("returns empty rather than Invalid Date", () => {
    assert.equal(F.relTime("", now), "");
    assert.equal(F.relTime(null, now), "");
    assert.equal(F.relTime("not a date", now), "");
  });

  test("accepts a Date, a number, or nothing at all for `now`", () => {
    const iso = ago(5 * MIN);
    assert.equal(F.relTime(iso, new Date(now)), "5m");
    assert.equal(F.relTime(iso, now), "5m");
    assert.equal(typeof F.relTime(new Date().toISOString()), "string");
  });
});

describe("fmtInt", () => {
  test("groups in threes with a thin space", () => {
    assert.equal(F.fmtInt(1284), "1" + F.THIN_SPACE + "284");
    assert.equal(F.fmtInt(999), "999");
    assert.equal(F.fmtInt(1000000), "1" + F.THIN_SPACE + "000" + F.THIN_SPACE + "000");
    assert.equal(F.fmtInt(0), "0");
  });

  test("THIN_SPACE is U+2009, not a regular space", () => {
    // A regular space would let the number wrap across two lines mid-value.
    assert.equal(F.THIN_SPACE, " ");
  });

  test("handles negatives and a custom separator", () => {
    assert.equal(F.fmtInt(-1284, ","), "-1,284");
    assert.equal(F.fmtInt(1284, ","), "1,284");
  });

  test("truncates fractions and refuses non-finite input", () => {
    assert.equal(F.fmtInt(12.9), "12");
    for (const v of [NaN, Infinity, null, "abc", undefined]) assert.equal(F.fmtInt(v), "0");
  });
});

describe("escapeQuery", () => {
  test("returns '' — not '?' — when there is nothing to send", () => {
    // Callers write `path + escapeQuery(o)`, so a bare "?" would be a bad URL.
    assert.equal(F.escapeQuery({}), "");
    assert.equal(F.escapeQuery(null), "");
    assert.equal(F.escapeQuery({ a: null, b: undefined, c: "" }), "");
  });

  test("keeps 0 and false, which are values and not absences", () => {
    assert.equal(F.escapeQuery({ n: 0 }), "?n=0");
    assert.equal(F.escapeQuery({ b: false }), "?b=false");
    assert.equal(F.escapeQuery({ b: true }), "?b=true");
  });

  test("joins arrays with a comma and drops empty ones", () => {
    assert.equal(F.escapeQuery({ tags: ["a", "b"] }), "?tags=a%2Cb");
    assert.equal(F.escapeQuery({ tags: [] }), "");
  });

  test("percent-encodes everything that would break a URL", () => {
    const q = F.escapeQuery({ q: 'a b&c#d="e"' });
    assert.ok(!q.includes(" "), q);
    assert.ok(!q.includes("#"), q);
    assert.equal(new URLSearchParams(q.slice(1)).get("q"), 'a b&c#d="e"', "round-trips");
  });
});
