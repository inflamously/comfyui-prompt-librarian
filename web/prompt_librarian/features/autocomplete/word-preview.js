/* One picture beside the suggestion menu, for the highlighted word.
 *
 * Pictures are small renders of the word from your own workflow (see
 * word-pictures/), or images picked by hand. Only words in the shared picture
 * map are fetched, each after the highlight settles; `v` (the version) lets the
 * browser cache the image as immutable.
 */

import { Component } from "../../shared/component.js";
import { loadWordImages, pictureOf, forgetPicture, wordKey } from "../../shared/pictures.js";

const SETTLE_MS = 120;
const SIZE = 128;
const GAP = 6;
const MARGIN = 8;

/** deps: api ({wordImage, removeWordImage, wordImages}), menu() -> the menu element. */
export class WordPreview extends Component {
  render() {
    const doc = this.deps.menu().ownerDocument;
    this.timer = null;
    this.controller = null;
    this.wanted = ""; // the key the highlight is on right now
    this.shown = null; // {key, version, url, page}
    const box = doc.createElement("div");
    box.className = "pl-word-preview";
    box.hidden = true;
    this.img = doc.createElement("img");
    this.img.decoding = "async";
    this.img.width = SIZE;
    this.img.height = SIZE;
    this.caption = doc.createElement("div");
    this.caption.className = "pl-word-preview-caption";
    const remove = doc.createElement("button");
    remove.type = "button";
    remove.className = "pl-word-preview-remove";
    remove.textContent = "×";
    remove.title = "Remove this picture";
    box.append(this.img, this.caption, remove);

    // Keep focus and the caret in the editor, like the menu's options.
    for (const type of ["pointerdown", "mousedown"]) this.listen(box, type, (e) => e.preventDefault());
    this.listen(remove, "click", (e) => { e.stopPropagation(); void this.removeShown(); });
    this.listen(this.img, "click", () => {
      if (this.shown?.page) doc.defaultView.open(this.shown.page, "_blank", "noopener");
    });
    this.own(() => {
      this.hide();
      if (this.shown) URL.revokeObjectURL(this.shown.url);
      this.shown = null;
    });
    return box;
  }

  /** Track the menu's highlight; a pictured word shows after the highlight settles. */
  follow(suggestion) {
    if (!this.el) return;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.wanted = suggestion && !this.deps.menu().hidden ? wordKey(suggestion.text) : "";
    const entry = this.wanted ? pictureOf(this.wanted) : undefined;
    if (!entry) {
      this.el.hidden = true;
      return;
    }
    if (this.shown && this.shown.key === this.wanted && this.shown.version === entry.version) {
      this.reveal();
      return;
    }
    this.el.hidden = true;
    const key = this.wanted;
    this.timer = setTimeout(() => void this.show(key, entry), SETTLE_MS);
  }

  async show(key, entry) {
    const { api } = this.deps;
    if (typeof api.wordImage !== "function") return;
    this.controller = new AbortController();
    const { signal } = this.controller;
    try {
      const blob = await api.wordImage(key, entry.version, signal);
      if (signal.aborted || key !== this.wanted || !this.el) return;
      if (this.shown) URL.revokeObjectURL(this.shown.url);
      this.shown = { key, version: entry.version, page: entry.page, url: URL.createObjectURL(blob) };
    } catch (_) {
      return; // superseded by a newer highlight, or the picture vanished
    }
    this.img.src = this.shown.url;
    this.img.alt = key;
    this.img.title = this.shown.page ? `Open ${this.shown.page}` : "";
    this.img.style.cursor = this.shown.page ? "pointer" : "";
    this.caption.textContent = key;
    this.reveal();
  }

  reveal() {
    if (this.deps.menu().hidden) return;
    this.el.hidden = false;
    this.place();
  }

  /** Beside the menu: right of it when there is room, otherwise left. */
  place() {
    if (!this.el || this.el.hidden) return;
    const view = this.el.ownerDocument.defaultView;
    const bounds = this.deps.menu().getBoundingClientRect();
    const width = this.el.offsetWidth || SIZE;
    let left = bounds.right + GAP;
    if (left + width > view.innerWidth - MARGIN) left = bounds.left - GAP - width;
    this.el.style.left = `${Math.max(MARGIN, left)}px`;
    this.el.style.top = `${Math.max(MARGIN, bounds.top)}px`;
  }

  hide() {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
    this.wanted = "";
    if (this.el) this.el.hidden = true;
  }

  async removeShown() {
    const { api } = this.deps;
    if (!this.shown || typeof api.removeWordImage !== "function") return;
    const key = this.shown.key;
    this.hide();
    forgetPicture(key);
    try {
      await api.removeWordImage(key);
    } catch (_) {
      void loadWordImages(api, { force: true }); // the server still has it: show it again
    }
  }
}
