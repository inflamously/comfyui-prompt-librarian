/* Arrange a word's pictures: a 3x3 board of slots, and the image as shown.
 *
 * A word holds up to nine pictures. What previews and tiles show is one
 * image laid out by count (1x1, 2x1, 2x2, 3x2, 3x3) and rebuilt by the server
 * whenever the order or the set changes. Move pictures with the arrows or by
 * dragging them onto another slot; × removes one.
 */

import { h, clear } from "../shared/dom.js";

export const MAX_PICTURES = 9;

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

/**
 * @param {{ctx: object, item: {word: string, picture: object|null},
 *          onChange: (picture: object|null) => void}} options
 */
export function openArrange({ ctx, item, onChange }) {
  const { API } = ctx;
  const word = item.word;
  let picture = item.picture;
  let busy = false;
  let dragFrom = -1;
  const urls = new Map(); // `${id}:${version}` -> object URL

  const counter = h("div", { className: "pl-arrange-count" });
  const slots = h("div", { className: "pl-arrange-slots", role: "list", "aria-label": "Picture slots" });
  const shown = h("div", { className: "pl-arrange-shown" });
  const el = h("div", { className: "pl-dialog pl-arrange", role: "dialog", "aria-modal": "true", "aria-label": `Pictures for ${word}`, tabIndex: -1 },
    h("div", { className: "pl-gallery-head" },
      h("div", { className: "pl-dialog-title" }, `Pictures for “${word}”`),
      counter,
      h("button", { className: "pl-btn pl-btn-sm", type: "button", "aria-label": "Close", onclick: () => ctx.popLayer(handle) }, "×")),
    h("div", { className: "pl-arrange-body" },
      h("div", { className: "pl-arrange-col" }, h("div", { className: "pl-arrange-label" }, "slots, in order"), slots),
      h("div", { className: "pl-arrange-col" }, h("div", { className: "pl-arrange-label" }, "as shown"), shown)),
    h("div", { className: "pl-gallery-hint" },
      "To add a picture, right-click any image node and pick “🖼️ Use as picture for words…”. One image can go to several words at once."));

  const handle = ctx.pushLayer({
    el, closeOnOutside: true, dim: true,
    onClose: () => { for (const url of urls.values()) URL.revokeObjectURL(url); },
  });
  if (!handle) return null;
  paint();

  function pictures() {
    return picture?.pictures || [];
  }

  function paint() {
    const list = pictures();
    const [columns, rows] = gridSize(list.length);
    counter.textContent = list.length
      ? `${list.length} of ${MAX_PICTURES} · shown as ${columns}×${rows}`
      : "no pictures";
    clear(slots);
    for (let i = 0; i < MAX_PICTURES; i++) slots.appendChild(i < list.length ? filled(list[i], i, list.length) : empty(i));
    clear(shown);
    if (picture) {
      const img = h("img", { alt: `${word}, as shown` });
      shown.appendChild(img);
      void load(img, picture.version, "");
    } else {
      shown.appendChild(h("div", { className: "pl-gallery-note" }, "no pictures left"));
    }
  }

  function filled(pic, i, count) {
    const img = h("img", { alt: `picture ${i + 1}`, draggable: "false" });
    void load(img, pic.version, pic.id);
    const cell = h("div", {
      className: "pl-arrange-slot is-filled", role: "listitem", draggable: "true",
      title: "drag onto another slot to move it",
      ondragstart: (event) => { dragFrom = i; event.dataTransfer?.setData("text/plain", String(i)); },
      ondragend: () => { dragFrom = -1; },
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => { event.preventDefault(); drop(i); },
    }, img,
    h("span", { className: "pl-arrange-num" }, String(i + 1)),
    h("div", { className: "pl-arrange-tools" },
      h("button", { type: "button", "aria-label": `move picture ${i + 1} earlier`, disabled: i === 0, onclick: () => move(i, i - 1) }, "◀"),
      h("button", { type: "button", "aria-label": `move picture ${i + 1} later`, disabled: i === count - 1, onclick: () => move(i, i + 1) }, "▶"),
      h("button", { type: "button", className: "is-danger", "aria-label": `remove picture ${i + 1}`, onclick: () => void remove(pic, i) }, "×")));
    return cell;
  }

  function empty(i) {
    return h("div", {
      className: "pl-arrange-slot", role: "listitem",
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => { event.preventDefault(); drop(i); },
    }, h("span", { className: "pl-arrange-num" }, String(i + 1)));
  }

  async function load(img, version, id) {
    const key = `${id}:${version}`;
    try {
      if (!urls.has(key)) urls.set(key, URL.createObjectURL(await API.wordImage(word, version, undefined, id || undefined)));
      img.src = urls.get(key);
    } catch (_) {
      img.alt = "picture missing";
    }
  }

  function drop(to) {
    if (dragFrom < 0) return;
    const from = dragFrom;
    dragFrom = -1;
    move(from, to);
  }

  function move(from, to) {
    const ids = pictures().map((p) => p.id);
    const target = Math.min(to, ids.length - 1);
    if (from === target) return;
    void change(() => API.orderWordImages(word, moveId(ids, from, target)));
  }

  async function remove(pic, i) {
    const ok = typeof ctx.confirmDialog === "function"
      ? await ctx.confirmDialog({
        title: "Remove picture", message: `Remove picture ${i + 1} from “${word}”?`, confirmLabel: "Remove",
      })
      : true;
    if (!ok) return;
    await change(async () => (await API.removeWordImage(word, pic.id))?.image || null);
  }

  /** Run one server change at a time; the response is the word's new picture entry. */
  async function change(work) {
    if (busy) return;
    busy = true;
    try {
      const next = await work();
      picture = next && next.version != null
        ? { version: next.version, source: next.source, page: next.page || "", pictures: next.pictures || [] }
        : null;
      paint();
      // Repainting removed the focused button; keep focus (and Esc) in the dialog.
      if (!el.contains(el.ownerDocument.activeElement)) el.focus();
      onChange(picture);
    } catch (err) {
      ctx.reportError(err, "arrange the pictures");
    } finally {
      busy = false;
    }
  }

  return handle;
}
