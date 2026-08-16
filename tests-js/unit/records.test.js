/* ==========================================================================
   inspector/records.js — the payload/record helpers

   Zero imports, no DOM, no state: the densest value-per-line in the tree, and
   `sig()` is the dirty comparison the entire save-on-close flow rests on.
   ========================================================================== */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { imp } from "../harness/mount.js";

const R = await imp("prompt_librarian/inspector/records.js");

describe("errMsg", () => {
  test("reads the useful field off whatever it is handed", () => {
    assert.equal(R.errMsg(null), "unknown error");
    assert.equal(R.errMsg(undefined), "unknown error");
    assert.equal(R.errMsg(""), "unknown error", "an empty string is not a message");
    assert.equal(R.errMsg("plain"), "plain");
    assert.equal(R.errMsg(new Error("boom")), "boom");
    assert.equal(R.errMsg({ error: "bad request" }), "bad request");
    assert.equal(R.errMsg({ code: "conflict" }), "conflict");
    assert.equal(R.errMsg({ message: "m", error: "e" }), "m", "message wins over error");
  });
});

describe("ensureOk", () => {
  test("passes healthy payloads straight through", () => {
    const ok = { id: "a", body: "b" };
    assert.equal(R.ensureOk(ok), ok, "returns the same object, not a copy");
    assert.equal(R.ensureOk(null), null);
    assert.equal(R.ensureOk("text"), "text");
  });

  test("throws with code and status when the payload carries an error", () => {
    // The API layer may throw OR hand back {error, code}; this unifies them.
    assert.throws(
      () => R.ensureOk({ error: "stale", code: "conflict", status: 409 }),
      (err) => {
        assert.equal(err.message, "stale");
        assert.equal(err.code, "conflict");
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  test("a falsy error field is not an error", () => {
    assert.deepEqual(R.ensureOk({ error: "" }), { error: "" });
    assert.deepEqual(R.ensureOk({ error: null }), { error: null });
  });
});

describe("isConflict", () => {
  test("recognises every shape a 409 arrives in", () => {
    assert.equal(R.isConflict({ code: "conflict" }), true);
    assert.equal(R.isConflict({ body: { code: "conflict" } }), true);
    assert.equal(R.isConflict({ data: { code: "conflict" } }), true);
    assert.equal(R.isConflict({ status: 409 }), true);
    assert.equal(R.isConflict({ statusCode: 409 }), true);
    assert.equal(R.isConflict({ message: "record changed (conflict)" }), true);
    assert.equal(R.isConflict({ error: "HTTP 409" }), true);
  });

  test("does not cry conflict at everything else", () => {
    // A false positive here shows the user a conflict dialog for an unrelated
    // failure, which is worse than the error toast they should have got.
    assert.equal(R.isConflict(null), false);
    assert.equal(R.isConflict(undefined), false);
    assert.equal(R.isConflict({}), false);
    assert.equal(R.isConflict({ code: "not_found" }), false);
    assert.equal(R.isConflict({ status: 400 }), false);
    assert.equal(R.isConflict({ status: 500 }), false);
    assert.equal(R.isConflict({ message: "conflicting instructions" }), false);
    assert.equal(R.isConflict({ message: "4090 tokens" }), false);
  });
});

describe("unwrapRecord", () => {
  test("accepts a bare record and both envelope shapes", () => {
    const bare = { id: "a", body: "x" };
    assert.equal(R.unwrapRecord(bare), bare);

    const rec = { id: "b", body: "y" };
    assert.equal(R.unwrapRecord({ prompt: rec }), rec);
    assert.equal(R.unwrapRecord({ record: rec }), rec);
  });

  test("carries the envelope's derived label onto the record", () => {
    // The label travels BESIDE the record on purpose — inside, it would end up
    // in the exported file, which is a stored name again by another route.
    const rec = { id: "b", body: "y" };
    const out = R.unwrapRecord({ prompt: rec, label: "a dancer" });
    assert.equal(out.label, "a dancer");
  });

  test("does not invent a label", () => {
    const rec = { id: "b" };
    assert.equal(R.unwrapRecord({ prompt: rec, label: "" }).label, undefined);
    assert.equal(R.unwrapRecord({ prompt: rec, label: 42 }).label, undefined);
    // A bare record is returned untouched, so no label is grafted on.
    const bare = { id: "c", label: "kept" };
    assert.equal(R.unwrapRecord(bare).label, "kept");
  });

  test("returns null for anything that is not an object", () => {
    for (const v of [null, undefined, "s", 3, true]) assert.equal(R.unwrapRecord(v), null);
  });
});

describe("frac and pct", () => {
  test("frac tolerates both a 0..1 and a 0..100 payload", () => {
    assert.equal(R.frac(0.87), 0.87);
    assert.equal(R.frac(1), 1);
    assert.equal(R.frac(87), 0.87, "anything over 1 is treated as a percentage");
    assert.equal(R.frac(100), 1);
    assert.equal(R.frac(0), 0);
  });

  test("frac is 0 for anything non-finite", () => {
    for (const v of [null, undefined, "", "abc", NaN, Infinity, {}]) {
      assert.equal(R.frac(v), 0, `frac(${String(v)})`);
    }
  });

  test("pct renders a rounded percentage", () => {
    assert.equal(R.pct(0.87), "87%");
    assert.equal(R.pct(87), "87%");
    assert.equal(R.pct(0.875), "88%");
    assert.equal(R.pct(1), "100%");
    assert.equal(R.pct(null), "0%");
  });
});

describe("matchesOf", () => {
  test("normalises both envelope shapes and a bare array", () => {
    const one = [{ id: 1, score: 0.5 }];
    assert.equal(R.matchesOf(one).length, 1);
    assert.equal(R.matchesOf({ matches: one }).length, 1);
    assert.equal(R.matchesOf({ dupes: one }).length, 1);
    assert.deepEqual(R.matchesOf(null), []);
    assert.deepEqual(R.matchesOf({}), []);
  });

  test("sorts by score, highest first", () => {
    const out = R.matchesOf([
      { id: "low", score: 0.1 },
      { id: "high", score: 0.99 },
      { id: "mid", score: 0.5 },
    ]);
    assert.deepEqual(
      out.map((m) => m.id),
      ["high", "mid", "low"],
    );
  });

  test("accepts `ratio` as an alias for `score`", () => {
    assert.equal(R.matchesOf([{ id: "a", ratio: 0.42 }])[0].score, 0.42);
    assert.equal(R.matchesOf([{ id: "a", ratio: 42 }])[0].score, 0.42);
  });

  test("label falls back preview → id → a stand-in, never blank", () => {
    // A row has to say something, and the id is the only thing every match has.
    assert.equal(R.matchesOf([{ id: "a", label: "L", preview: "P" }])[0].label, "L");
    assert.equal(R.matchesOf([{ id: "a", preview: "P" }])[0].label, "P");
    assert.equal(R.matchesOf([{ id: "a" }])[0].label, "a");
    assert.equal(R.matchesOf([{}])[0].label, "(empty prompt)");
  });

  test("coerces ids to strings and skips holes", () => {
    const out = R.matchesOf([{ id: 7 }, null, undefined, { id: "x" }]);
    assert.deepEqual(
      out.map((m) => m.id),
      ["7", "x"],
    );
  });

  test("normalises summary and body", () => {
    const [m] = R.matchesOf([{ id: "a", summary: null, body: 5 }]);
    assert.equal(m.summary, "", "a missing summary is an empty string, not null");
    assert.equal(m.body, null, "a non-string body is null, not coerced");
    assert.equal(R.matchesOf([{ id: "a", body: "text" }])[0].body, "text");
  });
});

describe("bufferFrom", () => {
  test("always yields {tags: string[], body: string}", () => {
    assert.deepEqual(R.bufferFrom({ tags: ["a", 2], body: "x" }), { tags: ["a", "2"], body: "x" });
    assert.deepEqual(R.bufferFrom({}), { tags: [], body: "" });
    assert.deepEqual(R.bufferFrom(null), { tags: [], body: "" });
    assert.deepEqual(R.bufferFrom({ tags: "not-an-array" }), { tags: [], body: "" });
  });

  test("copies the tags rather than aliasing them", () => {
    const rec = { tags: ["a"], body: "x" };
    const buf = R.bufferFrom(rec);
    buf.tags.push("b");
    assert.deepEqual(rec.tags, ["a"], "editing the buffer must not mutate the record");
  });
});

describe("sig — the dirty comparison", () => {
  test("is insensitive to tag ORDER", () => {
    assert.equal(R.sig({ tags: ["b", "a"], body: "x" }), R.sig({ tags: ["a", "b"], body: "x" }));
  });

  test("is sensitive to tag CONTENT and to the body", () => {
    assert.notEqual(R.sig({ tags: ["a"], body: "x" }), R.sig({ tags: ["a", "b"], body: "x" }));
    assert.notEqual(R.sig({ tags: ["a"], body: "x" }), R.sig({ tags: ["a"], body: "y" }));
    assert.notEqual(R.sig({ tags: ["a"], body: "x" }), R.sig({ tags: ["z"], body: "x" }));
  });

  test("ignores the label, deliberately", () => {
    // The label is derived from the body AND from the rest of the library, so a
    // label that moved because a DIFFERENT record was saved is not an unsaved
    // edit of this one. If this ever fails, closing the panel starts writing
    // records nobody edited.
    assert.equal(
      R.sig({ tags: ["a"], body: "x", label: "one" }),
      R.sig({ tags: ["a"], body: "x", label: "two" }),
    );
  });

  test("ignores every other field too", () => {
    assert.equal(
      R.sig({ tags: [], body: "x" }),
      R.sig({ tags: [], body: "x", rating: 5, used: 99, updated: "then", pinned: true }),
    );
  });

  test("survives null, undefined and missing fields", () => {
    assert.equal(R.sig(null), R.sig({}));
    assert.equal(R.sig(undefined), R.sig({ tags: [], body: "" }));
    assert.equal(R.sig({ body: null }), R.sig({ body: "" }));
  });

  test("does not confuse tag boundaries", () => {
    // Regression. sig() used to be JSON.stringify([tags.sort().join(""), body]),
    // so two tag sets with the same sorted concatenation were identical:
    // isDirty() reported false, save() returned "clean", and save-on-close
    // discarded the retag without a word.
    assert.notEqual(R.sig({ tags: ["catdog"], body: "" }), R.sig({ tags: ["cat", "dog"], body: "" }));
    assert.notEqual(R.sig({ tags: ["ab"], body: "" }), R.sig({ tags: ["a", "b"], body: "" }));
    // No separator would have been safe either: clean_tag() only collapses
    // whitespace to "-", so a tag may contain any other character.
    assert.notEqual(R.sig({ tags: ["a-b"], body: "" }), R.sig({ tags: ["a", "b"], body: "" }));
  });

  test("keeps the body and the tags from bleeding into each other", () => {
    assert.notEqual(R.sig({ tags: ["a"], body: "" }), R.sig({ tags: [], body: "a" }));
  });
});

describe("draftBody", () => {
  test("accepts a raw string", () => {
    assert.equal(R.draftBody("hello"), "hello");
    assert.equal(R.draftBody(""), "");
  });

  test("accepts the modal's JSON buffer", () => {
    assert.equal(R.draftBody('{"body":"hi","tags":[]}'), "hi");
    assert.equal(R.draftBody({ body: "hi" }), "hi");
  });

  test("a body that legitimately starts with { is not eaten as JSON", () => {
    // Wildcard syntax is {a|b}, so this is a real prompt, not an envelope.
    assert.equal(R.draftBody("{red|blue} car"), "{red|blue} car");
  });

  test("null-ish in, null out", () => {
    assert.equal(R.draftBody(null), null);
    assert.equal(R.draftBody(undefined), null);
    assert.equal(R.draftBody({}), null);
    assert.equal(R.draftBody('{"tags":[]}'), null, "valid JSON with no body");
  });
});

describe("DRAFT_PREFIX", () => {
  test("is the sessionStorage keyspace the modal and inspector share", () => {
    assert.equal(R.DRAFT_PREFIX, "pl:draft:");
  });
});
