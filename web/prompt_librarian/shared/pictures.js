/* The page-wide map of word pictures: {word: {version, source, page, pictures}}.
 * It is fetched once per page and shared through the singleton bag, so the
 * autocomplete preview, the gallery, the generator and the node menu all see
 * one map. A word that is not in it has no picture and costs no request.
 */

import { singleton } from "./singleton.js";

/** The key a word's picture is stored under; mirrors the backend's normalize(). */
export function wordKey(text) {
  return String(text || "").trim().split(/\s+/).join(" ").toLowerCase();
}

function cache() {
  return singleton("wordImages", () => ({ map: new Map(), loading: null }));
}

/** Load the map once with `api.wordImages()`; `force` refetches it. */
export function loadWordImages(api, { force = false } = {}) {
  const state = cache();
  if (typeof api?.wordImages !== "function") return Promise.resolve(state.map);
  if (state.loading && !force) return state.loading;
  state.loading = Promise.resolve()
    .then(() => api.wordImages())
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

/** Record a picture made in this page without refetching the map. */
export function rememberPicture(word, { version, source, page, pictures } = {}) {
  if (version != null) {
    cache().map.set(wordKey(word), { version, source, page: page || "", pictures: pictures || [] });
  }
}

/** Forget a word's picture removed in this page. */
export function forgetPicture(word) {
  cache().map.delete(wordKey(word));
}

/** The known picture for a word or phrase, or undefined. */
export function pictureOf(text) {
  return cache().map.get(wordKey(text));
}
