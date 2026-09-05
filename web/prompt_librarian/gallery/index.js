/* The word gallery: every word your prompts use, with its picture, a plain
 * dictionary definition, and an A/B render of what it changes.
 *
 * Opened from the header's "gallery" button; lives on the modal's layer stack,
 * so Esc and an outside click close it like any other dialog.
 */

import { h } from "../shared/dom.js";
import { comfy } from "../api/request.js";
import { forgetPicture, rememberPicture } from "../inspector/word-preview.js";
import { openArrange } from "./arrange.js";
import { DOWNLOAD_LABEL, createEntry } from "./entry.js";
import { createGrid } from "./grid.js";
import { runCompare } from "./compare.js";

const LIMIT = 5000;

/** @param {import("../modal/context.js").PaneContext} ctx */
export function openGallery(ctx) {
  const grid = createGrid({
    API: ctx.API, onPick: (item) => void entry.show(item), install, downloadLabel: DOWNLOAD_LABEL,
    onKey: ctx.onKey,
  });
  const entry = createEntry({
    API: ctx.API, onRelated: (word) => grid.select(word), install, actions: { find, compare, arrange },
  });
  let installing = null;
  const comparisons = new Set();
  const el = h("div", { className: "pl-dialog pl-gallery", role: "dialog", "aria-modal": "true", "aria-label": "Word gallery" },
    h("div", { className: "pl-gallery-head" },
      h("div", { className: "pl-dialog-title" }, "Word gallery"),
      h("div", { className: "pl-gallery-sub" }, "the words your prompts use, what they mean, and what they do"),
      h("button", { className: "pl-btn pl-btn-sm", type: "button", "aria-label": "Close", onclick: () => ctx.popLayer(handle) }, "×")),
    h("div", { className: "pl-gallery-body" }, grid.el, entry.el));

  const handle = ctx.pushLayer({
    el, closeOnOutside: true, dim: true,
    onClose: () => {
      grid.destroy();
      entry.destroy();
      for (const url of comparisons) URL.revokeObjectURL(url);
    },
  });
  if (!handle) return null;
  grid.focus();
  void load();

  async function load() {
    try {
      const { words } = await ctx.API.gallery(LIMIT);
      grid.setWords(Array.isArray(words) ? words : []);
    } catch (err) {
      grid.setWords([]);
      ctx.reportError(err, "load the word gallery");
    }
  }

  /** Download the dictionary once; both the search row and the entry offer it. */
  function install() {
    installing ??= ctx.API.installDictionary()
      .then((result) => {
        if (!result?.installed) throw new Error(result?.error || "the download failed");
        ctx.toast(`dictionary ready: ${result.words.toLocaleString()} words`, { kind: "success" });
        grid.refreshDictionary();
        entry.reload();
        return true;
      })
      .catch((err) => {
        installing = null;
        ctx.toast(`could not download the dictionary: ${err?.message || err}`, { kind: "error" });
        return false;
      });
    return installing;
  }

  function arrange(item) {
    if (!item.picture) return;
    openArrange({
      ctx, item,
      onChange: (picture) => {
        item.picture = picture;
        if (picture) rememberPicture(item.word, picture);
        else forgetPicture(item.word);
        grid.updateTile(item);
        entry.setPicture(item);
      },
    });
  }

  function find(word) {
    if (!ctx.list || typeof ctx.list.search !== "function") return;
    ctx.popLayer(handle);
    void ctx.list.search(word.includes(" ") ? `"${word}"` : word);
  }

  async function compare(item, box) {
    box.hidden = false;
    box.replaceChildren(h("div", { className: "pl-gallery-loading" }, "rendering A (without)…"));
    const base = ctx.inspector?.getBuffer?.().body || "";
    try {
      const result = await runCompare({
        app: ctx.app, nodeId: ctx.getTargetNodeId(), base, word: item.word, host: comfy,
        onStep: (which) => {
          box.firstChild.textContent = which === "a" ? "rendering A (without)…" : "rendering B (with)…";
        },
      });
      await showComparison(item, box, result);
    } catch (err) {
      box.replaceChildren(h("div", { className: "pl-gallery-note" }, `Could not compare: ${err?.message || err}`));
    }
  }

  async function showComparison(item, box, result) {
    const [a, b] = await Promise.all([result.imageA, result.imageB].map(async (image) => {
      const url = URL.createObjectURL(await comfy.view(image));
      comparisons.add(url);
      return url;
    }));
    const keep = h("button", {
      className: "pl-btn pl-btn-sm", type: "button",
      title: "Add the B render to this word's pictures",
      onclick: async () => {
        keep.disabled = true;
        try {
          const saved = await ctx.API.attachWordImage({ ...result.imageB, word: item.word, source: "generated" });
          rememberPicture(saved.word || item.word, saved);
          item.picture = { version: saved.version, source: saved.source, page: saved.page || "", pictures: saved.pictures || [] };
          grid.updateTile(item);
          entry.setPicture(item);
          keep.textContent = "kept";
        } catch (err) {
          keep.disabled = false;
          ctx.reportError(err, "keep the picture");
        }
      },
    }, "add B to pictures");
    box.replaceChildren(
      h("div", { className: "pl-gallery-ab" },
        side("A", result.had ? "without the word" : "your prompt", a, result.a),
        side("B", result.had ? "your prompt (with it)" : "with the word", b, result.b)),
      h("div", { className: "pl-gallery-acts" }, keep));
  }

  return handle;
}

function side(letter, label, url, text) {
  return h("figure", { className: "pl-gallery-side" },
    h("img", { src: url, alt: `${letter}: ${label}` }),
    h("figcaption", null, h("b", null, `${letter} `), label,
      h("div", { className: "pl-gallery-text", title: text }, text || "(empty prompt)")));
}
