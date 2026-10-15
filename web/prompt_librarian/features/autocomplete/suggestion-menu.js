/* The suggestion dropdown: its DOM, the highlighted option, and the editor's
 * combobox attributes, which it sets while attached and restores on destroy.
 * Options take clicks without taking focus, so the caret stays in the editor.
 */

import { Component } from "../../shared/component.js";
import { placeDropdown } from "./completion-position.js";

const EDITOR_ATTRIBUTES = ["aria-autocomplete", "aria-controls", "aria-expanded", "aria-activedescendant"];

/**
 * deps: textarea, onAccept(suggestion), onHighlight(suggestion|null) on every
 * highlight change (null on hide), hasPicture(text) to mark pictured words.
 */
export class SuggestionMenu extends Component {
  render() {
    const { textarea } = this.deps;
    const original = new Map(EDITOR_ATTRIBUTES.map((name) => [name, textarea.getAttribute(name)]));
    this.own(() => {
      for (const [name, value] of original) {
        if (value === null) textarea.removeAttribute(name);
        else textarea.setAttribute(name, value);
      }
    });
    this.suggestions = [];
    this.selected = 0;
    const menu = textarea.ownerDocument.createElement("div");
    menu.className = "pl-autocomplete";
    menu.id = "pl-autocomplete-" + Math.random().toString(36).slice(2);
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Saved prompt suggestions");
    menu.hidden = true;
    textarea.setAttribute("aria-autocomplete", "list");
    textarea.setAttribute("aria-controls", menu.id);
    textarea.setAttribute("aria-expanded", "false");
    this.own(() => this.hide());
    return menu;
  }

  /** Show `items` with the first one highlighted. */
  show(items) {
    this.suggestions = items;
    this.selected = 0;
    this.el.replaceChildren(...items.map((s, i) => this.option(s, i)));
    this.el.hidden = false;
    this.deps.textarea.setAttribute("aria-expanded", "true");
    this.reposition();
    this.highlight();
  }

  hide() {
    if (!this.el) return;
    this.suggestions = [];
    this.el.hidden = true;
    this.el.replaceChildren();
    this.deps.textarea.setAttribute("aria-expanded", "false");
    this.deps.textarea.removeAttribute("aria-activedescendant");
    this.deps.onHighlight(null);
  }

  /** Move the highlight by `direction` (±1), wrapping at the ends. */
  moveSelection(direction) {
    const n = this.suggestions.length;
    this.selected = (this.selected + direction + n) % n;
    this.highlight();
  }

  /** Follow the caret, e.g. after the editor scrolled. */
  reposition() {
    if (!this.el.hidden) placeDropdown(this.el, this.deps.textarea);
  }

  isOpen() {
    return !!this.el && !this.el.hidden;
  }

  contains(node) {
    return !!this.el?.contains(node);
  }

  selectedSuggestion() {
    return this.suggestions[this.selected];
  }

  highlight() {
    [...this.el.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === this.selected)));
    const option = this.el.children[this.selected];
    if (option) {
      this.deps.textarea.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView?.({ block: "nearest" });
    }
    this.deps.onHighlight(this.suggestions[this.selected] || null);
  }

  option(suggestion, index) {
    const option = this.el.ownerDocument.createElement("div");
    const count = suggestion.source_count;
    option.id = `${this.el.id}-${index}`;
    option.setAttribute("role", "option");
    option.textContent = suggestion.text; // saved text, never HTML
    option.title = `${count} saved prompt${count === 1 ? "" : "s"}`;
    if (this.deps.hasPicture(suggestion.text)) option.classList.add("has-picture");
    for (const type of ["pointerdown", "mousedown"]) option.addEventListener(type, (e) => e.preventDefault());
    option.addEventListener("click", () => this.deps.onAccept(suggestion));
    return option;
  }
}
