/* A fixed-position `.pl-popover` anchored to an element. It is placed from the
 * anchor's viewport rectangle, flipped above when the room below is short, and
 * clamped into the viewport. It closes on Escape, outside pointerdown, and any
 * scroll or resize (a fixed popover cannot follow a scrolling anchor).
 *
 * With a LayerStack the stack owns it, so outside clicks and the scrim are
 * handled there; without one it mounts on document.body and listens itself.
 * Key handling goes through the shared key bus: the modal's capture guard keeps
 * native key events from reaching listeners inside it.
 */

import { Component } from "../component.js";
import { h } from "../dom.js";
import { onKey } from "../keys.js";
import { NS } from "../ns.js";

const GAP = 6;
const EDGE = 8;
const MIN_FLIP_ROOM = 96; // never flip into a slot smaller than this

export class Popover extends Component {
  /**
   * deps: anchor (an element, or a getter for anchors that re-render), placement
   * ("bottom-start" | "bottom-end" | "top-start" | "top-end" | "overlay-start" |
   * "overlay-end"), className, ariaLabel, onClose.
   */
  constructor(deps) {
    super(deps);
    this.closed = false;
    this.layers = null;
    this.layer = null;
    this._placedOnce = false;
  }

  render() {
    const { className, ariaLabel } = this.deps;
    const el = h("div", {
      className: "pl-popover" + (className ? " " + className : ""),
      role: "group",
      "aria-label": ariaLabel || "options",
    });
    Object.assign(el.style, { position: "fixed", top: "0px", left: "-9999px" }); // measured, then placed
    // Stop Escape here so the modal does not also pop a layer.
    this.own(onKey(el, "keydown", (e) => {
      if (e.key !== "Escape" && e.key !== "Esc") return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }));
    const win = el.ownerDocument.defaultView;
    this.listen(win, "scroll", (e) => { if (!el.contains(e.target)) this.close(); }, true);
    this.listen(win, "resize", () => this.close());
    return el;
  }

  /** Mount on `layers`, or on document.body with its own outside-click listener. */
  open(layers) {
    if (layers) {
      this.layers = layers;
      this.layer = layers.push({ component: this, closeOnOutside: true, onClose: () => this.close() });
      return this;
    }
    this.mount(document.body);
    this.listen(document, "pointerdown", (e) => {
      if (this.el.contains(e.target) || this.anchor()?.contains(e.target)) return;
      this.close();
    }, true);
    return this;
  }

  /** Whether the popover is still showing. */
  isOpen() {
    return !this.closed;
  }

  /** Close once, from any path, then call onClose. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.layers?.pop(this.layer); // destroys this component when it was open on the stack
    this.destroy();
    try {
      this.deps.onClose?.();
    } catch (err) {
      console.error(`${NS} popover onClose failed`, err);
    }
  }

  /** The live anchor element; null when it is gone or detached (it would measure as 0×0). */
  anchor() {
    let node = this.deps.anchor;
    if (typeof node === "function") {
      try {
        node = node();
      } catch (_) {
        return null;
      }
    }
    if (!node || typeof node.getBoundingClientRect !== "function" || node.isConnected === false) return null;
    return node;
  }

  /** Place against the anchor; keep the last position if the anchor disappears. */
  reposition() {
    if (this.closed) return;
    if (place(this.el, this.anchor(), this.deps.placement)) {
      this._placedOnce = true;
    } else if (!this._placedOnce) {
      this.el.style.top = `${EDGE}px`;
      this.el.style.left = `${EDGE}px`;
    }
  }
}

/**
 * Open a Popover and fill it with `render(el, popover)`.
 * @returns {Popover|null} has el, close(), reposition(), isOpen(); null without a document
 */
export function openPopover({ render, layers, ...deps } = {}) {
  if (typeof document === "undefined") return null;
  const pop = new Popover(deps).open(layers);
  if (typeof render === "function") {
    try {
      const out = render(pop.el, pop);
      if (out?.nodeType && !pop.el.firstChild) pop.el.append(out);
    } catch (err) {
      console.error(`${NS} popover render failed`, err);
    }
  }
  pop.reposition();
  return pop;
}

function viewport() {
  const doc = document.documentElement;
  return { vw: window.innerWidth || doc.clientWidth || 1280, vh: window.innerHeight || doc.clientHeight || 800 };
}

function measure(el) {
  const r = el.getBoundingClientRect();
  return { w: r.width || el.offsetWidth || 220, h: r.height || el.offsetHeight || 160 };
}

/** Pick top/left for `el` against `anchor`; null when the anchor cannot be measured. */
function place(el, anchor, placement = "") {
  const rect = anchor?.getBoundingClientRect();
  // Hidden or detached anchors measure at the origin; do not place against them.
  if (!rect || (!rect.width && !rect.height && !rect.top && !rect.left)) return null;

  const { vw, vh } = viewport();
  const overlay = placement.startsWith("overlay");
  const alignEnd = placement.endsWith("end");

  let size = measure(el);
  const maxH = Math.max(MIN_FLIP_ROOM, vh - 2 * EDGE);
  if (size.h > maxH) {
    el.style.maxHeight = `${Math.round(maxH)}px`;
    size = measure(el); // after capping, remeasure before deciding to flip
  }
  const flipped = !overlay && shouldFlip(rect, size, vh, placement.startsWith("top"));

  let top = overlay ? rect.top : flipped ? rect.top - GAP - size.h : rect.bottom + GAP;
  top = Math.max(EDGE, Math.min(top, Math.max(EDGE, vh - EDGE - size.h)));
  let left = alignEnd ? rect.right - size.w : rect.left;
  left = Math.max(EDGE, Math.min(left, Math.max(EDGE, vw - EDGE - size.w)));

  Object.assign(el.style, { top: `${Math.round(top)}px`, left: `${Math.round(left)}px`, bottom: "auto", right: "auto" });
  el.dataset.flip = overlay ? "over" : flipped ? "up" : "down";
  return { top, left, flipped };
}

function shouldFlip(rect, size, vh, wantTop) {
  const roomBelow = vh - EDGE - (rect.bottom + GAP);
  const roomAbove = rect.top - GAP - EDGE;
  const fitsAbove = roomAbove >= Math.min(size.h, MIN_FLIP_ROOM);
  if (wantTop) return fitsAbove;
  return size.h > roomBelow && roomAbove > roomBelow && fitsAbove;
}
