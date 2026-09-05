/* "Generate word pictures…": render every vocabulary word that is not filler
 * and has no picture yet, using the open workflow, one small job at a time.
 */

import { API, comfy } from "../api/index.js";
import { singleton, warnOnce } from "../shared/singleton.js";
import { rememberPicture } from "../inspector/word-preview.js";
import { createPanel } from "./panel.js";
import { createRunner } from "./runner.js";
import { MAX_SIDE, prepareTemplate } from "./template.js";

const MAX_WORDS = 5000;

function notify(app, severity, summary, detail) {
  const toast = app?.extensionManager?.toast;
  if (typeof toast?.add === "function") toast.add({ severity, summary, detail, life: 5000 });
  else if (severity === "error") globalThis.alert?.(`${summary}: ${detail}`);
}

async function confirm(app, message) {
  const dialog = app?.extensionManager?.dialog;
  if (typeof dialog?.confirm === "function") {
    return dialog.confirm({ title: "Generate word pictures", message });
  }
  return globalThis.confirm?.(message) ?? false;
}

/** Ask, then render. `node` is the Librarian node whose text receives each word. */
export async function startWordPictures(node, app) {
  const run = singleton("wordPictureRun", () => ({ active: null }));
  if (run.active) {
    notify(app, "info", "Word pictures", "already generating; stop it first");
    return;
  }
  if (!comfy.available() || typeof app?.graphToPrompt !== "function") {
    notify(app, "error", "Word pictures", "this ComfyUI cannot queue prompts from extensions");
    return;
  }
  try {
    const template = prepareTemplate((await app.graphToPrompt()).output, node?.id);
    const { words, total } = await API.wordPictureCandidates(MAX_WORDS);
    if (!words?.length) {
      notify(app, "info", "Word pictures", "every word already has a picture");
      return;
    }
    const more = total > words.length ? ` (the ${words.length} most used of ${total})` : "";
    const ok = await confirm(app,
      `Render ${words.length} words${more} with this workflow, at most ${MAX_SIDE}px?\n\n` +
      "Jobs are queued one at a time, so your own prompts still run in between. " +
      "You can stop at any time; finished pictures are kept.");
    if (!ok) return;
    await runWithPanel(run, { words, template }, app);
  } catch (err) {
    notify(app, "error", "Word pictures", String(err?.message || err));
    warnOnce("word-pictures", "could not generate word pictures", err);
  }
}

async function runWithPanel(run, { words, template }, app) {
  let panel = null;
  const runner = createRunner({
    words,
    template,
    host: comfy,
    API,
    onPicture: (word, saved) => rememberPicture(saved.word || word, saved),
    onUpdate: (state) => panel?.update(state),
  });
  panel = createPanel(document, () => runner.stop());
  panel.update(runner.state());
  run.active = runner;
  try {
    const result = await runner.run();
    notify(app, "success", "Word pictures", `${result.done} made, ${result.failed} without an image`);
  } finally {
    run.active = null;
  }
}
