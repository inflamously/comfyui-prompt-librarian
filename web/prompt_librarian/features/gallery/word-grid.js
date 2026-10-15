/* The word tiles: search, a picture filter, and pages of thumbnails.
 *
 * The search box filters your own words and, once the dictionary is
 * downloaded, also lists dictionary words that start with what you typed;
 * Enter opens the typed word itself.
 *
 * Thumbnails load when a tile scrolls into view (or at once without
 * IntersectionObserver) and are cached as immutable by version, so reopening
 * the gallery costs no traffic. Object URLs are revoked on destroy.
 */

import { Component } from "../../shared/component.js";
import { clear, h } from "../../shared/dom.js";
import { fmtInt } from "../../shared/format.js";
import { onKey } from "../../shared/keys.js";
import { DOWNLOAD_LABEL, filterWords } from "./words.js";

const PAGE = 120;
const DICT_LIMIT = 16;
const DICT_SETTLE_MS = 150;
const FILTERS = [["all", "all"], ["pictured", "with picture"], ["bare", "no picture"]];

/** deps: api ({wordImage, searchDictionary}), onPick(item), install() -> Promise<boolean>. */
export class WordGrid extends Component {
  render() {
    this.words = [];
    this.shown = 0;
    this.filter = "all";
    this.selected = "";
    this.urls = new Set();
    this.view = globalThis.IntersectionObserver
      ? new IntersectionObserver((entries) => this.onVisible(entries), { rootMargin: "200px" })
      : null;
    this.input = h("input", {
      className: "pl-gallery-search", type: "search", placeholder: "search your words and the dictionary",
      "aria-label": "Search words", spellcheck: "false",
      oninput: () => { this.paint(); this.scheduleDictionary(); },
    });
    // The modal's capture guard keeps native key events away; use the key bus.
    this.own(onKey(this.input, "keydown", (e) => { if (e.key === "Enter") this.openTyped(); }));
    this.dict = h("div", { className: "pl-gallery-dict", hidden: true });
    this.filterEls = FILTERS.map(([key, label]) => h("button", {
      className: "pl-gallery-filter", type: "button", "aria-pressed": String(key === this.filter),
      onclick: () => { this.filter = key; this.paint(); },
    }, label));
    this.count = h("span", { className: "pl-gallery-count" }, "");
    this.tiles = h("div", { className: "pl-gallery-tiles", role: "listbox", "aria-label": "Words" });
    this.more = h("button", {
      className: "pl-btn pl-btn-sm pl-gallery-more", type: "button", hidden: true,
      onclick: () => this.paint(this.shown + PAGE),
    }, "show more");
    this.own(() => {
      clearTimeout(this.dictTimer);
      this.dictController?.abort();
      this.view?.disconnect();
      for (const url of this.urls) URL.revokeObjectURL(url);
      this.urls.clear();
    });
    return h("div", { className: "pl-gallery-grid" },
      h("div", { className: "pl-gallery-tools" }, this.input, ...this.filterEls, this.count),
      this.dict, this.tiles, this.more);
  }

  setWords(words) {
    this.words = words;
    this.paint();
  }

  focus() {
    this.input.focus();
  }

  /** Look the typed text up again, after the dictionary was downloaded. */
  refreshDictionary() {
    this.scheduleDictionary();
  }

  paint(limit = PAGE) {
    FILTERS.forEach(([key], i) => this.filterEls[i].setAttribute("aria-pressed", String(key === this.filter)));
    const matches = filterWords(this.words, this.input.value, this.filter);
    this.shown = Math.min(limit, matches.length);
    this.view?.disconnect();
    clear(this.tiles);
    for (const item of matches.slice(0, this.shown)) this.tiles.append(this.tile(item));
    this.count.textContent = `${fmtInt(matches.length)} word${matches.length === 1 ? "" : "s"}`;
    this.more.hidden = this.shown >= matches.length;
    if (!matches.length) {
      this.tiles.append(h("div", { className: "pl-gallery-empty" },
        this.words.length ? "no word matches" : "no words yet: save a few prompts first"));
    }
  }

  tile(item) {
    const el = h("button", {
      className: "pl-gallery-tile", type: "button", role: "option",
      "aria-selected": String(item.word === this.selected),
      title: `${item.word}: used in ${fmtInt(item.uses)} prompt${item.uses === 1 ? "" : "s"}`,
      onclick: () => this.pick(item),
    },
    h("div", { className: "pl-gallery-thumb" }, item.picture ? "" : item.word.slice(0, 1)),
    h("span", { className: "pl-gallery-word" }, item.word),
    h("span", { className: "pl-gallery-uses" }, fmtInt(item.uses)));
    el._item = item;
    if (item.picture) {
      if (this.view) this.view.observe(el);
      else void this.loadThumb(el);
    }
    return el;
  }

  onVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      this.view.unobserve(entry.target);
      void this.loadThumb(entry.target);
    }
  }

  async loadThumb(el) {
    const { word, picture } = el._item;
    try {
      const url = URL.createObjectURL(await this.deps.api.wordImage(word, picture.version));
      this.urls.add(url);
      const thumb = el.querySelector(".pl-gallery-thumb");
      clear(thumb);
      thumb.append(h("img", { src: url, alt: "", decoding: "async" }));
    } catch (_) {
      /* the picture vanished since the listing; the letter stays */
    }
  }

  scheduleDictionary() {
    clearTimeout(this.dictTimer);
    this.dictController?.abort();
    this.dictTimer = setTimeout(() => void this.searchDictionary(), DICT_SETTLE_MS);
  }

  /** Dictionary words starting with the query, minus the ones already shown as tiles. */
  async searchDictionary() {
    const { api } = this.deps;
    const q = this.input.value.trim();
    if (!q || typeof api.searchDictionary !== "function") {
      this.dict.hidden = true;
      return;
    }
    this.dictController = new AbortController();
    let found;
    try {
      found = await api.searchDictionary(q, DICT_LIMIT, this.dictController.signal);
    } catch (_) {
      return; // superseded by newer typing, or the backend is older
    }
    if (q === this.input.value.trim()) this.paintDictionary(found);
  }

  paintDictionary(found) {
    clear(this.dict);
    if (!found?.installed) {
      const button = h("button", {
        className: "pl-btn pl-btn-sm", type: "button",
        onclick: async () => {
          button.disabled = true;
          button.textContent = "downloading…";
          if (!(await this.deps.install())) { button.disabled = false; button.textContent = DOWNLOAD_LABEL; }
        },
      }, DOWNLOAD_LABEL);
      this.dict.append(h("span", { className: "pl-gallery-related-label" }, "search every English word:"), button);
      this.dict.hidden = false;
      return;
    }
    const mine = new Set(this.words.map((w) => w.word.toLowerCase()));
    const extra = (found.words || []).filter((w) => !mine.has(w.toLowerCase()));
    this.dict.hidden = !extra.length;
    if (!extra.length) return;
    this.dict.append(h("span", { className: "pl-gallery-related-label" }, "in the dictionary:"),
      ...extra.map((w) => h("button", { className: "pl-gallery-chip", type: "button", onclick: () => this.select(w) }, w)));
  }

  /** Enter: the one matching tile, or else the typed word, in or out of your prompts. */
  openTyped() {
    const q = this.input.value.trim();
    if (!q) return;
    const matches = filterWords(this.words, q, this.filter);
    if (matches.length === 1) this.pick(matches[0]);
    else this.select(q);
  }

  pick(item) {
    this.selected = item.word;
    for (const t of this.tiles.children) {
      if (t._item) t.setAttribute("aria-selected", String(t._item.word === this.selected));
    }
    this.deps.onPick(item);
  }

  /** Repaint one word's tile after its pictures changed. */
  updateTile(item) {
    for (const t of this.tiles.children) {
      if (t._item === item) {
        this.view?.unobserve(t);
        t.replaceWith(this.tile(item));
        return;
      }
    }
  }

  /** Show a word by spelling: its tile when it is one of yours, else a dictionary-only entry. */
  select(word) {
    const key = String(word || "").trim().toLowerCase();
    if (key) this.pick(this.words.find((w) => w.word.toLowerCase() === key) || { word: key, uses: 0, picture: null });
  }
}
