/* One word in detail: its picture, plain definitions with examples, related
 * words, and what to do with it (find prompts using it, compare A/B).
 */

import { h, clear } from "../shared/dom.js";
import { fmtInt } from "../shared/format.js";

export const DOWNLOAD_LABEL = "download dictionary (11 MB, once)";

/** The part of the dictionary answer that renders; pure, for tests. */
export function describe(answer) {
  const status = answer?.status || "not_installed";
  const view = { status, lemma: "", meanings: [], parts: [], source: answer?.source || "" };
  if (status === "missing") view.parts = answer.parts || [];
  if (status !== "found") return view;
  view.lemma = answer.lemma && answer.lemma !== answer.word ? answer.lemma : "";
  view.meanings = (answer.meanings || [])
    .filter((m) => m && m.definitions && m.definitions.length)
    .map((m) => ({
      part: m.part || "",
      senses: m.definitions.map((text, i) => ({ text, example: (m.examples || [])[i] || "" })),
      synonyms: m.synonyms || [],
      antonyms: m.antonyms || [],
    }));
  return view;
}

/**
 * @param {{API: object, onRelated: (word: string) => void, install: () => Promise<boolean>,
 *          actions: {find: Function, compare: Function, arrange: Function}}} options
 */
export function createEntry({ API, onRelated, install, actions }) {
  const el = h("div", { className: "pl-gallery-entry", "aria-live": "polite" },
    h("div", { className: "pl-gallery-hint" },
      "Pick a word, or search for any word, to see what it means, what it looks like, and what it changes in your prompt."));
  let current = null;
  let controller = null;
  let pictureUrl = "";
  let definitions = null;
  let picture = null;
  let arrangeButton = null;

  async function show(item) {
    current = item;
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    clear(el);
    picture = h("button", {
      className: "pl-gallery-big", type: "button", title: "arrange this word's pictures",
      onclick: () => actions.arrange(item),
    });
    arrangeButton = h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => actions.arrange(item) });
    definitions = h("div", { className: "pl-gallery-defs" }, h("div", { className: "pl-gallery-loading" }, "looking it up…"));
    const compareBox = h("div", { className: "pl-gallery-compare", hidden: true });
    const uses = item.uses
      ? `used in ${fmtInt(item.uses)} of your prompt${item.uses === 1 ? "" : "s"}`
      : "not in your prompts yet";
    el.append(
      h("div", { className: "pl-gallery-entry-head" },
        h("div", { className: "pl-gallery-entry-word" }, item.word),
        h("div", { className: "pl-gallery-entry-uses" }, uses)),
      picture,
      h("div", { className: "pl-gallery-acts" }, arrangeButton),
      definitions,
      h("div", { className: "pl-gallery-acts" },
        item.uses
          ? h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => actions.find(item.word) }, "find my prompts")
          : null,
        h("button", {
          className: "pl-btn pl-btn-sm pl-btn-primary", type: "button",
          title: "Render the prompt you are writing without and with this word, same seed, side by side",
          onclick: () => actions.compare(item, compareBox),
        }, "compare A/B")),
      compareBox);
    paintPicture(item, signal);
    await loadDefinition(item, signal);
  }

  function paintPicture(item, signal) {
    const count = item.picture?.pictures?.length || (item.picture ? 1 : 0);
    picture.textContent = item.picture ? "" : "no picture yet";
    arrangeButton.textContent = `arrange pictures (${count}/9)`;
    arrangeButton.hidden = !item.picture;
    picture.disabled = !item.picture;
    if (item.picture) void loadPicture(item, picture, signal);
  }

  /** The shown word's pictures changed (arranged, removed): repaint just the picture. */
  function setPicture(item) {
    if (item === current && picture && controller) paintPicture(item, controller.signal);
  }

  async function loadPicture(item, box, signal) {
    try {
      const blob = await API.wordImage(item.word, item.picture.version, signal);
      if (signal.aborted) return;
      if (pictureUrl) URL.revokeObjectURL(pictureUrl);
      pictureUrl = URL.createObjectURL(blob);
      clear(box);
      box.appendChild(h("img", { src: pictureUrl, alt: item.word }));
    } catch (_) {
      if (!signal.aborted) box.textContent = "no picture yet";
    }
  }

  async function loadDefinition(item, signal) {
    let answer;
    try {
      answer = await API.define(item.word, signal);
    } catch (_) {
      if (signal.aborted) return;
      answer = { status: "error" };
    }
    if (signal.aborted || current !== item) return;
    renderDefinition(definitions, describe(answer));
  }

  /** Look the shown word up again, after the dictionary was downloaded. */
  function reload() {
    if (current && definitions && controller) void loadDefinition(current, controller.signal);
  }

  function renderDefinition(box, view) {
    clear(box);
    if (view.status === "not_installed") {
      const button = h("button", {
        className: "pl-btn pl-btn-sm pl-btn-primary", type: "button",
        onclick: async () => {
          button.disabled = true;
          button.textContent = "downloading…";
          if (!(await install())) { button.disabled = false; button.textContent = DOWNLOAD_LABEL; }
        },
      }, DOWNLOAD_LABEL);
      box.appendChild(h("div", { className: "pl-gallery-note" },
        "The dictionary is not downloaded yet. It is WordNet: plain definitions, examples, similar and opposite words. After one download it works offline. ",
        button));
      return;
    }
    if (view.status === "missing") {
      box.appendChild(h("div", { className: "pl-gallery-note" }, view.parts.length
        ? "Not in the dictionary as a phrase. Its words:"
        : "Not in the dictionary. It may be a name, a style tag or an invented word; the picture and A/B compare still show what it does."));
      if (view.parts.length) box.appendChild(related("", view.parts));
      return;
    }
    if (view.status !== "found") {
      box.appendChild(h("div", { className: "pl-gallery-note" }, "Could not look this up."));
      return;
    }
    if (view.lemma) box.appendChild(h("div", { className: "pl-gallery-lemma" }, `listed as “${view.lemma}”`));
    for (const meaning of view.meanings) {
      box.appendChild(h("div", { className: "pl-gallery-meaning" },
        meaning.part ? h("div", { className: "pl-gallery-part" }, meaning.part) : null,
        h("ol", null, ...meaning.senses.map((s) => h("li", null, s.text,
          s.example ? h("div", { className: "pl-gallery-example" }, `“${s.example}”`) : null))),
        related("similar", meaning.synonyms),
        related("opposite", meaning.antonyms)));
    }
    if (view.source) box.appendChild(h("div", { className: "pl-gallery-source" }, `from ${view.source}`));
  }

  function related(label, words) {
    if (!words || !words.length) return null;
    return h("div", { className: "pl-gallery-related" },
      label ? h("span", { className: "pl-gallery-related-label" }, label) : null,
      ...words.map((w) => h("button", {
        className: "pl-gallery-chip", type: "button", title: `look up “${w}”`,
        onclick: () => onRelated(w),
      }, w)));
  }

  function destroy() {
    controller?.abort();
    if (pictureUrl) URL.revokeObjectURL(pictureUrl);
    pictureUrl = "";
  }

  return { el, show, reload, setPicture, destroy };
}
