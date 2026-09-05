/* One picture beside the autocomplete menu for the highlighted word.
 *
 * Pictures are small renders of the word from your own workflow (see
 * word-pictures/), or images you picked by hand. The {word: entry} map is
 * fetched once per page and shared; a word that is not in it makes no request.
 * Each image is fetched after the highlight settles, and `v` lets the browser
 * cache it as immutable.
 */

import { singleton } from "../shared/singleton.js";

const SETTLE_MS = 120;
const SIZE = 128;
const GAP = 6;
const MARGIN = 8;

/** The key a word's picture is stored under; mirrors the backend's normalize(). */
export function wordKey(text) {
  return String(text || "").trim().split(/\s+/).join(" ").toLowerCase();
}

function cache() {
  return singleton("wordImages", () => ({ map: new Map(), loading: null }));
}

/** Load the {word: {version, source, page}} map once; `force` refetches it. */
export function loadWordImages(API, { force = false } = {}) {
  const state = cache();
  if (typeof API?.wordImages !== "function") return Promise.resolve(state.map);
  if (state.loading && !force) return state.loading;
  state.loading = Promise.resolve()
    .then(() => API.wordImages())
    .then((response) => {
      state.map = new Map(Object.entries(response?.images || {}));
      return state.map;
    })
    .catch(() => {
      // Pictures are decoration: a failed listing just means none are shown yet.
      state.loading = null;
      return state.map;
    });
  return state.loading;
}

/** Record a picture made in this page (by the generator) without refetching. */
export function rememberPicture(word, { version, source, page, pictures } = {}) {
  if (version != null) {
    cache().map.set(wordKey(word), { version, source, page: page || "", pictures: pictures || [] });
  }
}

/** Forget a word's picture made or removed in this page (the gallery's arrange dialog). */
export function forgetPicture(word) {
  cache().map.delete(wordKey(word));
}

/** The known picture for a suggestion's text, or undefined. */
export function pictureOf(text) {
  return cache().map.get(wordKey(text));
}

/** A single preview box that follows the menu's highlighted suggestion. */
export function createWordPreview(menu, context) {
  const document = menu.ownerDocument;
  const box = document.createElement("div");
  box.className = "pl-word-preview";
  box.hidden = true;
  const img = document.createElement("img");
  img.decoding = "async";
  img.width = SIZE;
  img.height = SIZE;
  const caption = document.createElement("div");
  caption.className = "pl-word-preview-caption";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "pl-word-preview-remove";
  remove.textContent = "×";
  remove.title = "Remove this picture";
  box.append(img, caption, remove);
  (menu.parentNode || document.body).appendChild(box);

  let timer = null;
  let controller = null;
  let wanted = ""; // the key the highlight is on right now
  let shown = null; // {key, version, url, page}

  // Keep focus and caret in the editor, like the menu's own options.
  for (const type of ["pointerdown", "mousedown"]) {
    box.addEventListener(type, (event) => event.preventDefault());
  }
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    void removeShown();
  });
  img.addEventListener("click", () => {
    if (shown?.page) document.defaultView.open(shown.page, "_blank", "noopener");
  });

  function follow(suggestion) {
    clearTimeout(timer);
    controller?.abort();
    wanted = suggestion && !menu.hidden ? wordKey(suggestion.text) : "";
    const entry = wanted ? cache().map.get(wanted) : undefined;
    if (!entry) {
      box.hidden = true;
      return;
    }
    if (shown && shown.key === wanted && shown.version === entry.version) {
      reveal();
      return;
    }
    box.hidden = true;
    const key = wanted;
    timer = setTimeout(() => void show(key, entry), SETTLE_MS);
  }

  async function show(key, entry) {
    if (typeof context.API?.wordImage !== "function") return;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const blob = await context.API.wordImage(key, entry.version, signal);
      if (signal.aborted || key !== wanted) return;
      if (shown) URL.revokeObjectURL(shown.url);
      shown = { key, version: entry.version, page: entry.page, url: URL.createObjectURL(blob) };
    } catch (_) {
      return; // superseded by a newer highlight, or the picture vanished
    }
    img.src = shown.url;
    img.alt = key;
    img.title = shown.page ? `Open ${shown.page}` : "";
    img.style.cursor = shown.page ? "pointer" : "";
    caption.textContent = key;
    reveal();
  }

  function reveal() {
    if (menu.hidden) return;
    box.hidden = false;
    place();
  }

  /** Beside the menu: right of it when there is room, otherwise left. */
  function place() {
    if (box.hidden) return;
    const view = document.defaultView;
    const bounds = menu.getBoundingClientRect();
    const width = box.offsetWidth || SIZE;
    let left = bounds.right + GAP;
    if (left + width > view.innerWidth - MARGIN) left = bounds.left - GAP - width;
    box.style.left = `${Math.max(MARGIN, left)}px`;
    box.style.top = `${Math.max(MARGIN, bounds.top)}px`;
  }

  function hide() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    wanted = "";
    box.hidden = true;
  }

  async function removeShown() {
    if (!shown || typeof context.API?.removeWordImage !== "function") return;
    const key = shown.key;
    hide();
    cache().map.delete(key);
    try {
      await context.API.removeWordImage(key);
    } catch (_) {
      void loadWordImages(context.API, { force: true });
    }
  }

  function destroy() {
    hide();
    if (shown) URL.revokeObjectURL(shown.url);
    shown = null;
    box.remove();
  }

  return { follow, place, hide, destroy, element: box };
}
