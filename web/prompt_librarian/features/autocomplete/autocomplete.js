/* Completion for the prompt editor. Every edit asks the server for the word or
 * phrase at the caret, straight from the input event (no timer); a newer edit
 * cancels the older request. An accepted suggestion goes in through
 * setRangeText plus an `input` event, so it takes the editor's normal path.
 *
 * The root is `display: contents`, and it must be mounted outside the modal
 * card: the card's layout containment would offset the menu's fixed position.
 */

import { Component } from "../../shared/component.js";
import { dispatchInput, h } from "../../shared/dom.js";
import { onKey } from "../../shared/keys.js";
import { loadWordImages, pictureOf } from "../../shared/pictures.js";
import { useStyles } from "../../shared/styles.js";
import { completionContext, isShortCompletion } from "./completion-context.js";
import { SuggestionMenu } from "./suggestion-menu.js";
import { WordPreview } from "./word-preview.js";

/**
 * deps: textarea, api ({autocomplete, wordImages, wordImage, removeWordImage}),
 * caps ({autocomplete, word_images}: false turns one off), lane (a request lane).
 */
export class Autocomplete extends Component {
  render() {
    useStyles(new URL("./autocomplete.css", import.meta.url));
    const { textarea, api, caps = {} } = this.deps;
    const doc = textarea.ownerDocument;
    this.request = null; // {value, caret, completion} for the request in flight
    this.composing = false;
    this.accepting = false;

    const root = h("div", { className: "pl-autocomplete-layer", style: { display: "contents" } });
    this.menu = this.own(new SuggestionMenu({
      textarea,
      onAccept: (s) => this.accept(s),
      onHighlight: (s) => this.preview?.follow(s),
      hasPicture: (text) => !!pictureOf(text),
    })).mount(root);
    this.preview = this.own(new WordPreview({ api, menu: () => this.menu.el })).mount(root);
    if (caps.word_images !== false) void loadWordImages(api);

    // The modal's capture guard keeps native key events away; use the key bus.
    this.own(onKey(textarea, "keydown", (e) => this.onKeyDown(e)));
    this.listen(textarea, "input", (e) => this.onInput(e));
    this.listen(textarea, "blur", () => this.dismiss());
    this.listen(textarea, "pointerdown", () => this.dismiss());
    this.listen(textarea, "compositionstart", () => { this.composing = true; this.dismiss(); });
    this.listen(textarea, "compositionend", () => { this.composing = false; });
    this.listen(textarea, "select", () => this.onSelectionChange());
    this.listen(doc, "selectionchange", () => this.onSelectionChange());
    this.listen(doc, "scroll", (e) => this.onScroll(e), true);
    this.listen(doc.defaultView, "resize", () => this.dismiss());
    this.own(() => { this.detached = true; this.dismiss(); });
    return root;
  }

  /** Close the menu and drop the request in flight. */
  dismiss() {
    this.request = null;
    this.deps.lane.cancel();
    this.menu?.hide();
  }

  isCurrent(request) {
    const { textarea } = this.deps;
    return request !== null &&
      request === this.request &&
      !this.composing &&
      textarea.ownerDocument.activeElement === textarea &&
      textarea.value === request.value &&
      textarea.selectionStart === request.caret &&
      textarea.selectionEnd === request.caret;
  }

  onInput(event) {
    this.dismiss();
    const { textarea, api, caps = {} } = this.deps;
    if (this.detached || this.composing || event.isComposing || this.accepting) return;
    if (caps.autocomplete === false || typeof api.autocomplete !== "function") return;
    if (textarea.ownerDocument.activeElement !== textarea) return;
    const completion = completionContext(textarea.value, textarea.selectionStart, textarea.selectionEnd);
    if (!completion || (!completion.word_prefix && !completion.phrase_prefix)) return;
    this.request = { value: textarea.value, caret: textarea.selectionStart, completion };
    void this.ask(this.request);
  }

  async ask(request) {
    const { word_prefix, phrase_prefix } = request.completion;
    try {
      const response = await this.deps.lane((signal) =>
        this.deps.api.autocomplete({ word_prefix, phrase_prefix, limit: 8 }, signal));
      if (!this.isCurrent(request)) return;
      const suggestions = usable(response, request);
      if (suggestions.length) this.menu.show(suggestions);
      else this.dismiss();
    } catch (_) {
      // Completion is advisory; a failed request must leave editing alone.
      if (request === this.request) this.dismiss();
    }
  }

  accept(suggestion) {
    if (!suggestion || !this.isCurrent(this.request)) {
      this.dismiss();
      return;
    }
    const [start, end] = this.request.completion[suggestion.scope];
    const { textarea } = this.deps;
    this.dismiss();
    this.accepting = true;
    try {
      textarea.setRangeText(suggestion.text, start, end, "end");
      dispatchInput(textarea);
    } finally {
      this.accepting = false;
    }
  }

  onKeyDown(event) {
    if (this.composing || event.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return this.dismiss();
    if (event.key === "Escape") {
      if (this.menu.isOpen()) consume(event);
      return this.dismiss();
    }
    if (!this.menu.isOpen()) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (event.shiftKey) return;
        consume(event);
        this.menu.moveSelection(event.key === "ArrowDown" ? 1 : -1);
        break;
      case "Enter":
        if (event.shiftKey) return this.dismiss();
        consume(event);
        this.accept(this.menu.selectedSuggestion());
        break;
      case "Tab":
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        this.dismiss(); // and let focus navigation and caret movement happen
        break;
    }
  }

  onSelectionChange() {
    if (this.request && !this.isCurrent(this.request)) this.dismiss();
  }

  onScroll(event) {
    // The caret can scroll the editor during input: follow without cancelling.
    if (!this.menu.contains(event.target)) {
      this.menu.reposition();
      this.preview.place();
    }
  }
}

/** The suggestions worth offering for `request`: short, scoped, and not already typed. */
function usable(response, request) {
  const suggestions = Array.isArray(response?.suggestions) ? response.suggestions : [];
  return suggestions.filter((s) => {
    if (typeof s?.text !== "string") return false;
    if (!isShortCompletion(s.text)) return false; // an older server may return sentences
    if (s.scope !== "word" && s.scope !== "phrase") return false;
    if (!request.completion[`${s.scope}_prefix`]) return false;
    const [start, end] = request.completion[s.scope];
    return s.text !== request.value.slice(start, end);
  });
}

function consume(event) {
  event.preventDefault();
  event.stopPropagation();
}
