/* One word in detail: its picture, plain definitions with examples, related
 * words, and what to do with it (find prompts using it, compare A/B).
 */

import { Component } from "../../shared/component.js";
import { clear, h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { DOWNLOAD_LABEL, describe } from "./words.js";

/**
 * deps: api ({wordImage, define}), onRelated(word), install() -> Promise<boolean>,
 * actions ({find(word), compare(item, box), arrange(item)}).
 */
export class WordEntry extends Component {
  render() {
    this.current = null;
    this.pictureUrl = "";
    this.own(() => {
      this.controller?.abort();
      if (this.pictureUrl) URL.revokeObjectURL(this.pictureUrl);
      this.pictureUrl = "";
    });
    return h("div", { className: "pl-gallery-entry", "aria-live": "polite" },
      h("div", { className: "pl-gallery-hint" },
        "Pick a word, or search for any word, to see what it means, what it looks like, and what it changes in your prompt."));
  }

  async show(item) {
    const { actions } = this.deps;
    this.current = item;
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    clear(this.el);
    this.picture = h("button", {
      className: "pl-gallery-big", type: "button", title: "arrange this word's pictures",
      onclick: () => actions.arrange(item),
    });
    this.arrangeButton = h("button", { className: "pl-btn pl-btn-sm", type: "button", onclick: () => actions.arrange(item) });
    this.definitions = h("div", { className: "pl-gallery-defs" }, h("div", { className: "pl-gallery-loading" }, "looking it up…"));
    const compareBox = h("div", { className: "pl-gallery-compare", hidden: true });
    const uses = item.uses ? `used in ${fmtInt(item.uses)} of your prompt${item.uses === 1 ? "" : "s"}` : "not in your prompts yet";
    this.el.append(
      h("div", { className: "pl-gallery-entry-head" },
        h("div", { className: "pl-gallery-entry-word" }, item.word),
        h("div", { className: "pl-gallery-entry-uses" }, uses)),
      this.picture,
      h("div", { className: "pl-gallery-acts" }, this.arrangeButton),
      this.definitions,
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
    this.paintPicture(item, signal);
    await this.loadDefinition(item, signal);
  }

  /** The shown word's pictures changed (arranged, removed): repaint just the picture. */
  setPicture(item) {
    if (item === this.current && this.picture && this.controller) this.paintPicture(item, this.controller.signal);
  }

  /** Look the shown word up again, after the dictionary was downloaded. */
  reload() {
    if (this.current && this.definitions && this.controller) void this.loadDefinition(this.current, this.controller.signal);
  }

  paintPicture(item, signal) {
    const count = item.picture?.pictures?.length || (item.picture ? 1 : 0);
    this.picture.textContent = item.picture ? "" : "no picture yet";
    this.arrangeButton.textContent = `arrange pictures (${count}/9)`;
    this.arrangeButton.hidden = !item.picture;
    this.picture.disabled = !item.picture;
    if (item.picture) void this.loadPicture(item, this.picture, signal);
  }

  async loadPicture(item, box, signal) {
    try {
      const blob = await this.deps.api.wordImage(item.word, item.picture.version, signal);
      if (signal.aborted) return;
      if (this.pictureUrl) URL.revokeObjectURL(this.pictureUrl);
      this.pictureUrl = URL.createObjectURL(blob);
      clear(box);
      box.append(h("img", { src: this.pictureUrl, alt: item.word }));
    } catch (_) {
      if (!signal.aborted) box.textContent = "no picture yet";
    }
  }

  async loadDefinition(item, signal) {
    let answer;
    try {
      answer = await this.deps.api.define(item.word, signal);
    } catch (_) {
      if (signal.aborted) return;
      answer = { status: "error" };
    }
    if (signal.aborted || this.current !== item) return;
    this.paintDefinition(describe(answer));
  }

  paintDefinition(view) {
    const box = this.definitions;
    clear(box);
    if (view.status === "not_installed") {
      const button = h("button", {
        className: "pl-btn pl-btn-sm pl-btn-primary", type: "button",
        onclick: async () => {
          button.disabled = true;
          button.textContent = "downloading…";
          if (!(await this.deps.install())) { button.disabled = false; button.textContent = DOWNLOAD_LABEL; }
        },
      }, DOWNLOAD_LABEL);
      box.append(h("div", { className: "pl-gallery-note" },
        "The dictionary is not downloaded yet. It is WordNet: plain definitions, examples, similar and opposite words. After one download it works offline. ",
        button));
      return;
    }
    if (view.status === "missing") {
      box.append(h("div", { className: "pl-gallery-note" }, view.parts.length
        ? "Not in the dictionary as a phrase. Its words:"
        : "Not in the dictionary. It may be a name, a style tag or an invented word; the picture and A/B compare still show what it does."));
      if (view.parts.length) box.append(this.related("", view.parts));
      return;
    }
    if (view.status !== "found") {
      box.append(h("div", { className: "pl-gallery-note" }, "Could not look this up."));
      return;
    }
    if (view.lemma) box.append(h("div", { className: "pl-gallery-lemma" }, `listed as “${view.lemma}”`));
    for (const meaning of view.meanings) {
      box.append(h("div", { className: "pl-gallery-meaning" },
        meaning.part ? h("div", { className: "pl-gallery-part" }, meaning.part) : null,
        h("ol", null, ...meaning.senses.map((s) => h("li", null, s.text,
          s.example ? h("div", { className: "pl-gallery-example" }, `“${s.example}”`) : null))),
        this.related("similar", meaning.synonyms),
        this.related("opposite", meaning.antonyms)));
    }
    if (view.source) box.append(h("div", { className: "pl-gallery-source" }, `from ${view.source}`));
  }

  related(label, words) {
    if (!words || !words.length) return null;
    return h("div", { className: "pl-gallery-related" },
      label ? h("span", { className: "pl-gallery-related-label" }, label) : null,
      ...words.map((w) => h("button", {
        className: "pl-gallery-chip", type: "button", title: `look up “${w}”`,
        onclick: () => this.deps.onRelated(w),
      }, w)));
  }
}
