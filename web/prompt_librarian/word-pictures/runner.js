/* Render words one at a time through ComfyUI and keep each result as a picture.
 *
 * Only one job is queued at a time, so anything you queue yourself slips in
 * between words instead of waiting behind hundreds of them. Stop takes effect
 * after the word that is rendering; cancelling that job in ComfyUI stops the
 * whole run. Three failures in a row stop it too, since the workflow is
 * probably broken for every word.
 */

import { wordPrompt } from "./template.js";

const EVENTS = ["executed", "executing", "execution_success", "execution_error", "execution_interrupted"];
const MAX_FAILURES_IN_A_ROW = 3;

class Interrupted extends Error {}

/**
 * @param {{words: string[], template: object, host: {queue: Function, on: Function},
 *          API: object, onPicture?: Function, onUpdate?: Function}} options
 */
export function createRunner({ words, template, host, API, onPicture = () => {}, onUpdate = () => {} }) {
  const state = { total: words.length, done: 0, failed: 0, current: "", running: false, stopped: false, error: "" };

  async function run() {
    state.running = true;
    let inARow = 0;
    for (const word of words) {
      if (state.stopped) break;
      state.current = word;
      onUpdate({ ...state });
      try {
        const saved = await renderAndKeep(word);
        if (saved) {
          state.done += 1;
          inARow = 0;
          onPicture(word, saved);
        } else {
          state.failed += 1;
          inARow += 1;
        }
      } catch (err) {
        state.failed += 1;
        inARow += 1;
        if (err instanceof Interrupted) {
          state.stopped = true;
          state.error = "cancelled in ComfyUI";
        } else {
          state.error = String(err?.message || err);
        }
      }
      if (inARow >= MAX_FAILURES_IN_A_ROW) {
        state.stopped = true;
        state.error = `stopped after ${inARow} failures in a row: ${state.error || "no image came back"}`;
      }
    }
    state.running = false;
    state.current = "";
    onUpdate({ ...state });
    return { ...state };
  }

  async function renderAndKeep(word) {
    const images = await render(host, wordPrompt(template, word));
    const image = images.find((img) => img && typeof img.filename === "string");
    if (!image) return null;
    return API.attachWordImage({
      word,
      filename: image.filename,
      subfolder: image.subfolder || "",
      type: image.type || "temp",
      source: "generated",
    });
  }

  function stop() {
    state.stopped = true;
    onUpdate({ ...state });
  }

  return { run, stop, state: () => ({ ...state }) };
}

/** Queue one prompt and collect its images. Events are buffered from before the
 * queue call, because a fast job can finish before its prompt_id is known here.
 */
export async function render(host, prompt) {
  const events = [];
  let wake = () => {};
  const offs = EVENTS.map((type) => host.on(type, (detail) => {
    events.push([type, detail]);
    wake();
  }));
  try {
    const { prompt_id: id } = await host.queue(prompt);
    const images = [];
    for (;;) {
      while (events.length) {
        const [type, detail] = events.shift();
        if (!detail || detail.prompt_id !== id) continue;
        if (type === "executed") images.push(...(detail.output?.images || []));
        else if (type === "execution_success") return images;
        else if (type === "executing" && detail.node == null) return images; // older servers
        else if (type === "execution_interrupted") throw new Interrupted("interrupted");
        else if (type === "execution_error") throw new Error(detail.exception_message || "execution error");
      }
      await new Promise((resolve) => { wake = resolve; });
    }
  } finally {
    for (const off of offs) off();
  }
}
