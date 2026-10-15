/* Arrange a word's pictures: a 3x3 board of slots, and the image as shown.
 *
 * A word holds up to nine pictures. What previews and tiles show is one image
 * laid out by count (1x1, 2x1, 2x2, 3x2, 3x3) and rebuilt by the server
 * whenever the order or the set changes. Move pictures with the arrows or by
 * dragging them onto another slot; × removes one.
 */

import { Component } from "../../shared/component.js";
import { clear, h } from "../../shared/dom.js";
import { useStyles } from "../../shared/styles.js";
import { MAX_PICTURES, gridSize, moveId, pictureEntry } from "./words.js";

/**
 * deps: item ({word, picture}), onChange(picture|null), api ({wordImage,
 * orderWordImages, removeWordImage}), confirm(opts), reportError(err, what), close().
 */
export class ArrangeDialog extends Component {
  render() {
    useStyles(new URL("./gallery.css", import.meta.url));
    const { word } = this.deps.item;
    this.picture = this.deps.item.picture;
    this.busy = false;
    this.dragFrom = -1;
    this.urls = new Map(); // `${id}:${version}` -> object URL
    this.own(() => { for (const url of this.urls.values()) URL.revokeObjectURL(url); });
    this.counter = h("div", { className: "pl-arrange-count" });
    this.slots = h("div", { className: "pl-arrange-slots", role: "list", "aria-label": "Picture slots" });
    this.shown = h("div", { className: "pl-arrange-shown" });
    return h("div", { className: "pl-dialog pl-arrange", role: "dialog", "aria-modal": "true", "aria-label": `Pictures for ${word}`, tabIndex: -1 },
      h("div", { className: "pl-gallery-head" },
        h("div", { className: "pl-dialog-title" }, `Pictures for “${word}”`),
        this.counter,
        h("button", { className: "pl-btn pl-btn-sm", type: "button", "aria-label": "Close", onclick: () => this.deps.close() }, "×")),
      h("div", { className: "pl-arrange-body" },
        h("div", { className: "pl-arrange-col" }, h("div", { className: "pl-arrange-label" }, "slots, in order"), this.slots),
        h("div", { className: "pl-arrange-col" }, h("div", { className: "pl-arrange-label" }, "as shown"), this.shown)),
      h("div", { className: "pl-gallery-hint" },
        "To add a picture, right-click any image node and pick “🖼️ Use as picture for words…”. One image can go to several words at once."));
  }

  mount(parent) {
    super.mount(parent);
    this.paint();
    return this;
  }

  pictures() {
    return this.picture?.pictures || [];
  }

  paint() {
    const list = this.pictures();
    const [columns, rows] = gridSize(list.length);
    this.counter.textContent = list.length ? `${list.length} of ${MAX_PICTURES} · shown as ${columns}×${rows}` : "no pictures";
    clear(this.slots);
    for (let i = 0; i < MAX_PICTURES; i++) this.slots.append(i < list.length ? this.filled(list[i], i, list.length) : this.empty(i));
    clear(this.shown);
    if (this.picture) {
      const img = h("img", { alt: `${this.deps.item.word}, as shown` });
      this.shown.append(img);
      void this.load(img, this.picture.version, "");
    } else {
      this.shown.append(h("div", { className: "pl-gallery-note" }, "no pictures left"));
    }
  }

  filled(pic, i, count) {
    const img = h("img", { alt: `picture ${i + 1}`, draggable: "false" });
    void this.load(img, pic.version, pic.id);
    return h("div", {
      className: "pl-arrange-slot is-filled", role: "listitem", draggable: "true",
      title: "drag onto another slot to move it",
      ondragstart: (event) => { this.dragFrom = i; event.dataTransfer?.setData("text/plain", String(i)); },
      ondragend: () => { this.dragFrom = -1; },
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => { event.preventDefault(); this.drop(i); },
    }, img,
    h("span", { className: "pl-arrange-num" }, String(i + 1)),
    h("div", { className: "pl-arrange-tools" },
      h("button", { type: "button", "aria-label": `move picture ${i + 1} earlier`, disabled: i === 0, onclick: () => this.move(i, i - 1) }, "◀"),
      h("button", { type: "button", "aria-label": `move picture ${i + 1} later`, disabled: i === count - 1, onclick: () => this.move(i, i + 1) }, "▶"),
      h("button", { type: "button", className: "is-danger", "aria-label": `remove picture ${i + 1}`, onclick: () => void this.remove(pic, i) }, "×")));
  }

  empty(i) {
    return h("div", {
      className: "pl-arrange-slot", role: "listitem",
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => { event.preventDefault(); this.drop(i); },
    }, h("span", { className: "pl-arrange-num" }, String(i + 1)));
  }

  async load(img, version, id) {
    const key = `${id}:${version}`;
    try {
      if (!this.urls.has(key)) {
        this.urls.set(key, URL.createObjectURL(await this.deps.api.wordImage(this.deps.item.word, version, undefined, id || undefined)));
      }
      img.src = this.urls.get(key);
    } catch (_) {
      img.alt = "picture missing";
    }
  }

  drop(to) {
    if (this.dragFrom < 0) return;
    const from = this.dragFrom;
    this.dragFrom = -1;
    this.move(from, to);
  }

  move(from, to) {
    const ids = this.pictures().map((p) => p.id);
    const target = Math.min(to, ids.length - 1);
    if (from !== target) void this.change(() => this.deps.api.orderWordImages(this.deps.item.word, moveId(ids, from, target)));
  }

  async remove(pic, i) {
    const { word } = this.deps.item;
    const ok = await this.deps.confirm({ title: "Remove picture", message: `Remove picture ${i + 1} from “${word}”?`, confirmLabel: "Remove" });
    if (ok) await this.change(async () => (await this.deps.api.removeWordImage(word, pic.id))?.image || null);
  }

  /** Run one server change at a time; the answer is the word's new picture entry. */
  async change(work) {
    if (this.busy) return;
    this.busy = true;
    try {
      this.picture = pictureEntry(await work());
      this.paint();
      // Repainting removed the focused button; keep focus (and Esc) in the dialog.
      if (!this.el.contains(this.el.ownerDocument.activeElement)) this.el.focus();
      this.deps.onChange(this.picture);
    } catch (err) {
      this.deps.reportError(err, "arrange the pictures");
    } finally {
      this.busy = false;
    }
  }
}
