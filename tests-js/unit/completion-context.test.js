import { test } from "node:test";
import assert from "node:assert/strict";
import { imp } from "../harness/mount.js";
const { completionContext } = await imp("prompt_librarian/inspector/completion-context.js");

test("Unicode offsets, phrase end eligibility and selections", () => {
  const body = "😀,  cafe\u0301 li  , after";
  const caret = body.indexOf("  , after");
  const c = completionContext(body, caret);
  assert.equal(c.word_prefix, "li");
  assert.equal(c.phrase_prefix, "cafe\u0301 li");
  assert.equal(body.slice(...c.phrase), "cafe\u0301 li");
  assert.equal(completionContext("light more", 2).phrase_prefix, "");
  assert.deepEqual(completionContext("light more", 2).word, [0, 5]);
  assert.equal(completionContext("vol", 1, 2), null);
  assert.equal(completionContext("😀", 2).word_prefix, "");
});
