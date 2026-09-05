import { test } from "node:test";
import assert from "node:assert/strict";
import { imp, seedHost } from "../harness/mount.js";

seedHost();
const T = await imp("prompt_librarian/word-pictures/template.js");
const R = await imp("prompt_librarian/word-pictures/runner.js");

const workflow = () => ({
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 4 } },
  "6": { class_type: "PromptLibrarian", inputs: { text: "a long prompt", prompt_id: "p1" } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: ["6", 0], clip: ["4", 1] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "ComfyUI" } },
});

test("fitSize keeps the aspect, caps the long side and snaps to 64", () => {
  assert.deepEqual(T.fitSize(832, 1216), [320, 512]);
  assert.deepEqual(T.fitSize(1024, 1024), [512, 512]);
  assert.deepEqual(T.fitSize(512, 384), [512, 384], "never scales up");
  assert.deepEqual(T.fitSize(4096, 100), [512, 64], "never below one step");
  assert.deepEqual(T.fitSize(1024, 1024, 384), [384, 384]);
});

test("a word prompt sets the text, shrinks latents and previews instead of saving", () => {
  const original = workflow();
  const prep = T.prepareTemplate(original, 6);
  const prompt = T.wordPrompt(prep, "red fox");
  assert.equal(prompt["6"].inputs.text, "red fox");
  assert.deepEqual(prompt["5"].inputs, { width: 320, height: 512, batch_size: 1 });
  assert.deepEqual(prompt["9"], { class_type: "PreviewImage", inputs: { images: ["8", 0] } });
  assert.equal(original["6"].inputs.text, "a long prompt", "the template is never mutated");
  assert.equal(original["9"].class_type, "SaveImage");
});

test("the template refuses workflows that cannot work", () => {
  const two = { ...workflow(), "10": { class_type: "PromptLibrarian", inputs: { text: "b" } } };
  assert.equal(T.prepareTemplate(two, 10).textId, "10", "the clicked node wins");
  assert.throws(() => T.prepareTemplate(two, 99), /exactly one/);
  const wired = workflow(); wired["6"].inputs.text = ["3", 0];
  assert.throws(() => T.prepareTemplate(wired, 6), /wired/);
  const blind = workflow(); delete blind["9"];
  assert.throws(() => T.prepareTemplate(blind, 6), /Save Image or Preview Image/);
});

/** A fake ComfyUI: queues get ids, and `script(word)` decides what comes back. */
function fakeHost(script) {
  const listeners = new Map();
  const queued = [];
  const emit = (type, detail) => (listeners.get(type) || []).forEach((fn) => fn(detail));
  return {
    queued,
    listeners,
    on(type, fn) {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
      return () => listeners.set(type, listeners.get(type).filter((f) => f !== fn));
    },
    async queue(prompt) {
      const id = `p${queued.length}`;
      queued.push(prompt);
      const word = prompt["6"].inputs.text;
      // Fire synchronously-ish, before the caller has the id: the runner must buffer.
      queueMicrotask(() => script(word, id, emit));
      return { prompt_id: id };
    },
  };
}

const ok = (word, id, emit) => {
  emit("executed", { prompt_id: "other", output: { images: [{ filename: "not-mine.png" }] } });
  emit("executed", { prompt_id: id, node: "9", output: { images: [{ filename: `${word}.png`, subfolder: "", type: "temp" }] } });
  emit("execution_success", { prompt_id: id });
};

function fakeApi() {
  const attached = [];
  return {
    attached,
    attachWordImage: async (body) => { attached.push(body); return { word: body.word, version: attached.length, source: "generated", page: "" }; },
  };
}

test("words render one at a time and each image becomes a generated picture", async () => {
  const host = fakeHost(ok);
  const API = fakeApi();
  const seen = [];
  const runner = R.createRunner({
    words: ["fox", "owl"], template: T.prepareTemplate(workflow(), 6), host, API,
    onPicture: (word) => seen.push(word),
  });
  const result = await runner.run();
  assert.equal(host.queued.length, 2);
  assert.deepEqual(API.attached.map((a) => [a.word, a.filename, a.type, a.source]),
    [["fox", "fox.png", "temp", "generated"], ["owl", "owl.png", "temp", "generated"]]);
  assert.deepEqual(seen, ["fox", "owl"]);
  assert.equal(result.done, 2);
  assert.equal([...host.listeners.values()].flat().length, 0, "every listener is removed");
});

test("stop finishes the current word and queues nothing more", async () => {
  let runner;
  const host = fakeHost((word, id, emit) => { runner.stop(); ok(word, id, emit); });
  runner = R.createRunner({ words: ["a1", "b2", "c3"], template: T.prepareTemplate(workflow(), 6), host, API: fakeApi() });
  const result = await runner.run();
  assert.equal(host.queued.length, 1);
  assert.equal(result.done, 1);
  assert.equal(result.stopped, true);
});

test("cancelling in ComfyUI ends the run; repeated failures stop it", async () => {
  const cancelled = fakeHost((_w, id, emit) => emit("execution_interrupted", { prompt_id: id }));
  const one = await R.createRunner({ words: ["a1", "b2"], template: T.prepareTemplate(workflow(), 6), host: cancelled, API: fakeApi() }).run();
  assert.equal(cancelled.queued.length, 1);
  assert.match(one.error, /cancelled/);

  const broken = fakeHost((_w, id, emit) => emit("execution_error", { prompt_id: id, exception_message: "CUDA OOM" }));
  const many = await R.createRunner({ words: ["a1", "b2", "c3", "d4", "e5"], template: T.prepareTemplate(workflow(), 6), host: broken, API: fakeApi() }).run();
  assert.equal(broken.queued.length, 3);
  assert.match(many.error, /3 failures in a row: CUDA OOM/);
});

test("older servers finish with executing(node=null)", async () => {
  const host = fakeHost((word, id, emit) => {
    emit("executed", { prompt_id: id, output: { images: [{ filename: "x.png" }] } });
    emit("executing", { prompt_id: id, node: null });
  });
  const result = await R.createRunner({ words: ["fox"], template: T.prepareTemplate(workflow(), 6), host, API: fakeApi() }).run();
  assert.equal(result.done, 1);
});
