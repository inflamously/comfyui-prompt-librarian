/* The word gallery: every word your prompts use, with its picture, a plain
 * dictionary definition, and an A/B render of what it changes. It lives on the
 * modal's layer stack, so Esc and an outside click close it like any dialog.
 */

import { Component } from "../../shared/component.js";
import { h } from "../../shared/dom.js";
import { forgetPicture, rememberPicture } from "../../shared/pictures.js";
import { useStyles } from "../../shared/styles.js";
import { runCompare } from "./ab-compare.js";
import { WordEntry } from "./word-entry.js";
import { WordGrid } from "./word-grid.js";
import { pictureEntry } from "./words.js";

const LIMIT = 5000;

/**
 * deps: api, toast, reportError, openArrange(opts), onFind(word), base() -> the
 * prompt being written, nodeId(), renderer (from word-pictures), viewImage(ref)
 * -> Blob, close().
 */
export class GalleryDialog extends Component {
  render() {
    useStyles(new URL("./gallery.css", import.meta.url));
    const { api } = this.deps;
    this.comparisons = new Set(); // A/B object URLs, revoked on close
    this.own(() => { for (const url of this.comparisons) URL.revokeObjectURL(url); });
    const install = () => this.install();
    this.grid = this.own(new WordGrid({ api, install, onPick: (item) => void this.entry.show(item) }));
    this.entry = this.own(new WordEntry({
      api, install,
      onRelated: (word) => this.grid.select(word),
      actions: { find: (w) => this.find(w), compare: (item, box) => this.compare(item, box), arrange: (item) => this.arrange(item) },
    }));
    const body = h("div", { className: "pl-gallery-body" });
    this.grid.mount(body);
    this.entry.mount(body);
    return h("div", { className: "pl-dialog pl-gallery", role: "dialog", "aria-modal": "true", "aria-label": "Word gallery" },
      h("div", { className: "pl-gallery-head" },
        h("div", { className: "pl-dialog-title" }, "Word gallery"),
        h("div", { className: "pl-gallery-sub" }, "the words your prompts use, what they mean, and what they do"),
        h("button", { className: "pl-btn pl-btn-sm", type: "button", "aria-label": "Close", onclick: () => this.deps.close() }, "×")),
      body);
  }

  mount(parent) {
    super.mount(parent);
    this.grid.focus();
    void this.load();
    return this;
  }

  async load() {
    try {
      const { words } = await this.deps.api.gallery(LIMIT);
      this.grid.setWords(Array.isArray(words) ? words : []);
    } catch (err) {
      this.grid.setWords([]);
      this.deps.reportError(err, "load the word gallery");
    }
  }

  /** Download the dictionary once; both the search row and the entry offer it. */
  install() {
    const { api, toast } = this.deps;
    this.installing ??= api.installDictionary()
      .then((result) => {
        if (!result?.installed) throw new Error(result?.error || "the download failed");
        toast(`dictionary ready: ${result.words.toLocaleString()} words`, { kind: "success" });
        this.grid.refreshDictionary();
        this.entry.reload();
        return true;
      })
      .catch((err) => {
        this.installing = null;
        toast(`could not download the dictionary: ${err?.message || err}`, { kind: "error" });
        return false;
      });
    return this.installing;
  }

  arrange(item) {
    if (!item.picture) return;
    this.deps.openArrange({ item, onChange: (picture) => this.pictureChanged(item, picture) });
  }

  pictureChanged(item, picture) {
    item.picture = picture;
    if (picture) rememberPicture(item.word, picture);
    else forgetPicture(item.word);
    this.grid.updateTile(item);
    this.entry.setPicture(item);
  }

  /** Close and search the rail for the word (quoted when it is a phrase). */
  find(word) {
    this.deps.close();
    this.deps.onFind(word.includes(" ") ? `"${word}"` : word);
  }

  async compare(item, box) {
    const { renderer, nodeId, base } = this.deps;
    box.hidden = false;
    box.replaceChildren(h("div", { className: "pl-gallery-loading" }, "rendering A (without)…"));
    try {
      const result = await runCompare({
        renderer, nodeId: nodeId(), base: base(), word: item.word,
        onStep: (which) => { box.firstChild.textContent = which === "a" ? "rendering A (without)…" : "rendering B (with)…"; },
      });
      await this.showComparison(item, box, result);
    } catch (err) {
      box.replaceChildren(h("div", { className: "pl-gallery-note" }, `Could not compare: ${err?.message || err}`));
    }
  }

  async showComparison(item, box, result) {
    const [a, b] = await Promise.all([result.imageA, result.imageB].map(async (image) => {
      const url = URL.createObjectURL(await this.deps.viewImage(image));
      this.comparisons.add(url);
      return url;
    }));
    const keep = h("button", {
      className: "pl-btn pl-btn-sm", type: "button", title: "Add the B render to this word's pictures",
      onclick: async () => {
        keep.disabled = true;
        try {
          const saved = await this.deps.api.attachWordImage({ ...result.imageB, word: item.word, source: "generated" });
          rememberPicture(saved.word || item.word, saved);
          item.picture = pictureEntry(saved);
          this.grid.updateTile(item);
          this.entry.setPicture(item);
          keep.textContent = "kept";
        } catch (err) {
          keep.disabled = false;
          this.deps.reportError(err, "keep the picture");
        }
      },
    }, "add B to pictures");
    box.replaceChildren(
      h("div", { className: "pl-gallery-ab" },
        side("A", result.had ? "without the word" : "your prompt", a, result.a),
        side("B", result.had ? "your prompt (with it)" : "with the word", b, result.b)),
      h("div", { className: "pl-gallery-acts" }, keep));
  }
}

function side(letter, label, url, text) {
  return h("figure", { className: "pl-gallery-side" },
    h("img", { src: url, alt: `${letter}: ${label}` }),
    h("figcaption", null, h("b", null, `${letter} `), label,
      h("div", { className: "pl-gallery-text", title: text }, text || "(empty prompt)")));
}
