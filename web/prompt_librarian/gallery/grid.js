/* The word tiles: search, a picture filter, and pages of thumbnails.
 *
 * The search box filters your own words and, once the dictionary is
 * downloaded, also lists dictionary words that start with what you typed;
 * Enter opens the typed word itself.
 *
 * Thumbnails load when a tile scrolls into view (or at once without
 * IntersectionObserver) and are cached as immutable by version, so reopening
 * the gallery costs no traffic. Object URLs are revoked on destroy().
 */

import { h, clear } from "../shared/dom.js";
import { fmtInt } from "../shared/format.js";

const PAGE = 120;
const DICT_LIMIT = 16;
const DICT_SETTLE_MS = 150;
const FILTERS = [
  ["all", "all"],
  ["pictured", "with picture"],
  ["bare", "no picture"],
];

/** The words that match a query and a filter, in the order given. */
export function filterWords(words, query, filter) {
  const q = String(query || "").trim().toLowerCase();
  return words.filter((w) => {
    if (filter === "pictured" && !w.picture) return false;
    if (filter === "bare" && w.picture) return false;
    return !q || w.word.toLowerCase().includes(q);
  });
}

/**
 * @param {{API: object, onPick: Function, install: () => Promise<boolean>, downloadLabel: string,
 *          onKey?: Function}} options `onKey` is the modal's key bus; native key
 *   listeners inside the modal never fire because of its capture guard.
 */
export function createGrid({ API, onPick, install, downloadLabel, onKey }) {
  let words = [];
  let shown = 0;
  let filter = "all";
  let selected = "";
  const urls = new Set();
  const view = globalThis.IntersectionObserver
    ? new IntersectionObserver(onVisible, { rootMargin: "200px" })
    : null;

  let dictTimer = null;
  let dictController = null;
  const input = h("input", {
    className: "pl-gallery-search", type: "search", placeholder: "search your words and the dictionary",
    "aria-label": "Search words", spellcheck: "false",
    oninput: () => { paint(); scheduleDictionary(); },
  });
  const offKey = typeof onKey === "function"
    ? onKey(input, "keydown", (event) => { if (event.key === "Enter") openTyped(); })
    : () => {};
  const dict = h("div", { className: "pl-gallery-dict", hidden: true });
  const filterEls = FILTERS.map(([key, label]) => h("button", {
    className: "pl-gallery-filter", type: "button", "aria-pressed": String(key === filter),
    onclick: () => { filter = key; paint(); },
  }, label));
  const count = h("span", { className: "pl-gallery-count" }, "");
  const tiles = h("div", { className: "pl-gallery-tiles", role: "listbox", "aria-label": "Words" });
  const more = h("button", {
    className: "pl-btn pl-btn-sm pl-gallery-more", type: "button", hidden: true,
    onclick: () => paint(shown + PAGE),
  }, "show more");
  const el = h("div", { className: "pl-gallery-grid" },
    h("div", { className: "pl-gallery-tools" }, input, ...filterEls, count),
    dict, tiles, more);

  function setWords(next) {
    words = next;
    paint();
  }

  function paint(limit = PAGE) {
    for (const [i, [key]] of FILTERS.entries()) filterEls[i].setAttribute("aria-pressed", String(key === filter));
    const matches = filterWords(words, input.value, filter);
    shown = Math.min(limit, matches.length);
    view?.disconnect();
    clear(tiles);
    for (const item of matches.slice(0, shown)) tiles.appendChild(tile(item));
    count.textContent = `${fmtInt(matches.length)} word${matches.length === 1 ? "" : "s"}`;
    more.hidden = shown >= matches.length;
    if (!matches.length) tiles.appendChild(h("div", { className: "pl-gallery-empty" }, words.length ? "no word matches" : "no words yet: save a few prompts first"));
  }

  function tile(item) {
    const thumb = h("div", { className: "pl-gallery-thumb" }, item.picture ? "" : item.word.slice(0, 1));
    const el = h("button", {
      className: "pl-gallery-tile", type: "button", role: "option",
      "aria-selected": String(item.word === selected),
      title: `${item.word}: used in ${fmtInt(item.uses)} prompt${item.uses === 1 ? "" : "s"}`,
      onclick: () => pick(item),
    }, thumb,
    h("span", { className: "pl-gallery-word" }, item.word),
    h("span", { className: "pl-gallery-uses" }, fmtInt(item.uses)));
    el._item = item;
    if (item.picture) {
      if (view) view.observe(el);
      else void loadThumb(el);
    }
    return el;
  }

  function onVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      view.unobserve(entry.target);
      void loadThumb(entry.target);
    }
  }

  async function loadThumb(el) {
    const { word, picture } = el._item;
    try {
      const url = URL.createObjectURL(await API.wordImage(word, picture.version));
      urls.add(url);
      const thumb = el.querySelector(".pl-gallery-thumb");
      clear(thumb);
      thumb.appendChild(h("img", { src: url, alt: "", decoding: "async" }));
    } catch (_) {
      /* the picture vanished since the listing; the letter stays */
    }
  }

  function scheduleDictionary() {
    clearTimeout(dictTimer);
    dictController?.abort();
    dictTimer = setTimeout(() => void searchDictionary(), DICT_SETTLE_MS);
  }

  /** Dictionary words starting with the query, minus the ones already shown as tiles. */
  async function searchDictionary() {
    const q = input.value.trim();
    if (!q || typeof API.searchDictionary !== "function") { dict.hidden = true; return; }
    dictController = new AbortController();
    let found;
    try {
      found = await API.searchDictionary(q, DICT_LIMIT, dictController.signal);
    } catch (_) {
      return; // superseded by newer typing, or the backend is older
    }
    if (q !== input.value.trim()) return;
    paintDictionary(found);
  }

  function paintDictionary(found) {
    clear(dict);
    if (!found?.installed) {
      const button = h("button", {
        className: "pl-btn pl-btn-sm", type: "button",
        onclick: async () => {
          button.disabled = true;
          button.textContent = "downloading…";
          if (!(await install())) { button.disabled = false; button.textContent = downloadLabel; }
        },
      }, downloadLabel);
      dict.append(h("span", { className: "pl-gallery-related-label" }, "search every English word:"), button);
      dict.hidden = false;
      return;
    }
    const mine = new Set(words.map((w) => w.word.toLowerCase()));
    const extra = (found.words || []).filter((w) => !mine.has(w.toLowerCase()));
    dict.hidden = !extra.length;
    if (!extra.length) return;
    dict.append(h("span", { className: "pl-gallery-related-label" }, "in the dictionary:"),
      ...extra.map((w) => h("button", {
        className: "pl-gallery-chip", type: "button", onclick: () => select(w),
      }, w)));
  }

  /** Enter: the one matching tile, or else the typed word, in or out of your prompts. */
  function openTyped() {
    const q = input.value.trim();
    if (!q) return;
    const matches = filterWords(words, q, filter);
    if (matches.length === 1) pick(matches[0]);
    else select(q);
  }

  function pick(item) {
    selected = item.word;
    for (const t of tiles.children) {
      if (t._item) t.setAttribute("aria-selected", String(t._item.word === selected));
    }
    onPick(item);
  }

  /** Repaint one word's tile after its pictures changed. */
  function updateTile(item) {
    for (const t of tiles.children) {
      if (t._item === item) { view?.unobserve(t); t.replaceWith(tile(item)); return; }
    }
  }

  /** Show a word by spelling: its tile when it is one of yours, else a dictionary-only entry. */
  function select(word) {
    const key = String(word || "").trim().toLowerCase();
    if (!key) return;
    pick(words.find((w) => w.word.toLowerCase() === key) || { word: key, uses: 0, picture: null });
  }

  function destroy() {
    offKey();
    clearTimeout(dictTimer);
    dictController?.abort();
    view?.disconnect();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  }

  return {
    el, setWords, select, updateTile, destroy,
    focus: () => input.focus(),
    refreshDictionary: () => scheduleDictionary(),
  };
}
