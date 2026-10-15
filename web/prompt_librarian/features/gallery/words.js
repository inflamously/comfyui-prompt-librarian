/* Pure helpers over the gallery's words and pictures. */

export const MAX_PICTURES = 9;
export const DOWNLOAD_LABEL = "download dictionary (11 MB, once)";

/** The words that match a query and a filter ("all" | "pictured" | "bare"), in order. */
export function filterWords(words, query, filter) {
  const q = String(query || "").trim().toLowerCase();
  return words.filter((w) => {
    if (filter === "pictured" && !w.picture) return false;
    if (filter === "bare" && w.picture) return false;
    return !q || w.word.toLowerCase().includes(q);
  });
}

/** `[columns, rows]` for `count` pictures; mirrors the server's layout(). */
export function gridSize(count) {
  if (count <= 1) return [1, 1];
  if (count === 2) return [2, 1];
  if (count <= 4) return [2, 2];
  if (count <= 6) return [3, 2];
  return [3, 3];
}

/** `ids` with the entry at `from` moved to `to` (clamped into the list). */
export function moveId(ids, from, to) {
  const out = ids.slice();
  const [id] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, id);
  return out;
}

/** The picture entry kept for a word, from a server answer (null when none is left). */
export function pictureEntry(answer) {
  return answer && answer.version != null
    ? { version: answer.version, source: answer.source, page: answer.page || "", pictures: answer.pictures || [] }
    : null;
}

/** The part of a dictionary answer that renders. */
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
