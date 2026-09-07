import { NS } from "../shared/ns.js";
import { h } from "../shared/dom.js";
import { warnOnce } from "../shared/singleton.js";
import { bindKeys, isFn, measure, viewport } from "./common.js";

const GAP = 6;
const EDGE = 8;
const MIN_FLIP_ROOM = 96; // never flip into a slot smaller than this

/** Mount outside .pl-card: its layout/paint containment would offset fixed
 * positioning based on viewport coordinates.
 */
function mountTarget(ctx) {
  let node = null;
  if (ctx && ctx.els && ctx.els.layers) node = ctx.els.layers;
  if (!node && ctx && ctx.root && isFn(ctx.root.querySelector)) {
    node = ctx.root.querySelector(".pl-layers");
  }
  if (!node && typeof document !== "undefined" && isFn(document.querySelector)) {
    node = document.querySelector(".pl-root .pl-layers");
  }
  if (node && isFn(node.closest) && node.closest(".pl-card")) {
    warnOnce("popover-in-card", ".pl-layers resolved inside .pl-card; popovers would be offset");
    node = null;
  }
  return node || (typeof document !== "undefined" ? document.body : null);
}

/**
 * Open a `.pl-popover` anchored to an element.
 *
 * - `position: fixed`, placed from `anchor.getBoundingClientRect()`, flipped
 *   above the anchor when it would overflow the viewport bottom, and clamped
 *   into the viewport horizontally.
 * - Rendered into `.pl-layers` through `ctx.pushLayer` when a ctx is given, so
 *   key isolation, the Escape handling and the focus trap all apply for free.
 * - Closes on outside pointerdown, Escape (top layer only), and ancestor
 *   scroll or resize.
 *
 * @param {object} opts
 * @param {HTMLElement|(() => HTMLElement)} opts.anchor an element, or a getter
 *   for callers whose anchor is re-created by a re-render (see `resolveAnchor`)
 * @param {(el: HTMLElement, handle: object) => any} [opts.render]
 * @param {string} [opts.placement] "bottom-start" | "bottom-end" | "top-start" |
 *   "top-end" | "overlay-start" | "overlay-end"
 * @param {string} [opts.className] extra class(es) on the popover
 * @param {() => void} [opts.onClose]
 * @param {object} [opts.ctx] modal ctx — enables the layer stack and the key bus
 * @param {string} [opts.ariaLabel]
 * @returns {{el: HTMLElement, close: () => void, reposition: () => void, isOpen: () => boolean}}
 */
export function openPopover({
  anchor,
  render,
  placement,
  className,
  onClose,
  ctx,
  ariaLabel,
} = {}) {
  if (typeof document === "undefined") return null;

  const el = h("div", {
    className: "pl-popover" + (className ? " " + className : ""),
    role: "group",
    "aria-label": ariaLabel || "options",
  });
  el.style.position = "fixed";
  el.style.top = "0px";
  el.style.left = "-9999px"; // measured off-screen, then placed

  let closed = false;
  let layerHandle = null;
  let placedOnce = false;
  const offs = [];

  /** Re-resolve anchors after re-render; detached elements measure as zero rectangles.
   */
  function resolveAnchor() {
    let node = anchor;
    if (isFn(node)) {
      try {
        node = node();
      } catch (_) {
        return null;
      }
    }
    if (!node || !isFn(node.getBoundingClientRect)) return null;
    if (node.isConnected === false) return null;
    return node;
  }

  const handle = {
    el,
    close,
    reposition,
    isOpen: () => !closed,
  };

  function close() {
    if (closed) return;
    closed = true;
    for (const off of offs) {
      try {
        off();
      } catch (_) {
        /* teardown must never throw */
      }
    }
    offs.length = 0;
    // popLayer() also removes the element; calling it with an already-popped
    // handle is a documented no-op, so this is safe on every close path.
    if (layerHandle && ctx && isFn(ctx.popLayer)) {
      try {
        ctx.popLayer(layerHandle);
      } catch (_) {
      }
    }
    if (el.parentNode) {
      try {
        el.parentNode.removeChild(el);
      } catch (_) {
      }
    }
    if (isFn(onClose)) {
      try {
        onClose();
      } catch (err) {
        console.error(`${NS} popover onClose failed`, err);
      }
    }
  }

  function reposition() {
    if (closed) return;
    if (place(el, resolveAnchor(), placement)) {
      placedOnce = true;
      return;
    }
    // If an anchor disappears, retain the previous position; park at the edge only
    // when it was never usable.
    if (placedOnce) return;
    el.style.top = `${EDGE}px`;
    el.style.left = `${EDGE}px`;
  }

  // Give outside-click handling one owner. With ctx, use only the layer stack;
  // a second listener could pop the layer before the modal handles pointerup.
  if (ctx && isFn(ctx.pushLayer)) {
    try {
      layerHandle = ctx.pushLayer({ el, closeOnOutside: true, onClose: close });
    } catch (_) {
      layerHandle = null;
    }
  }
  if (!layerHandle) {
    const parent = mountTarget(ctx);
    if (!parent) return handle;
    parent.appendChild(el);
    const onDown = (e) => {
      const t = e && e.target;
      if (!t) return;
      if (el.contains(t)) return;
      const a = resolveAnchor();
      if (a && isFn(a.contains) && a.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    offs.push(() => document.removeEventListener("pointerdown", onDown, true));
  }

  if (isFn(render)) {
    try {
      const out = render(el, handle);
      if (out && typeof Node !== "undefined" && out instanceof Node && !el.firstChild) {
        el.appendChild(out);
      }
    } catch (err) {
      console.error(`${NS} popover render failed`, err);
    }
  }

  // Stop Escape here so the modal cannot pop a second layer.
  offs.push(
    bindKeys(ctx, el, (e) => {
      if (!e) return;
      if (e.key === "Escape" || e.key === "Esc") {
        if (isFn(e.preventDefault)) e.preventDefault();
        if (isFn(e.stopPropagation)) e.stopPropagation();
        close();
      }
    })
  );

  // Dismiss on ancestor scroll: fixed popovers do not follow anchors. Capture is
  // required because scroll events do not bubble.
  if (typeof window !== "undefined") {
    const onScroll = (e) => {
      const t = e && e.target;
      if (t && isFn(el.contains) && t !== document && el.contains(t)) return; // our own list
      close();
    };
    const onResize = () => close();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    offs.push(() => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    });
  }

  reposition();
  return handle;
}

function place(el, anchor, placement) {
  if (!el || !anchor || !isFn(anchor.getBoundingClientRect)) return null;
  let rect;
  try {
    rect = anchor.getBoundingClientRect();
  } catch (_) {
    return null;
  }
  if (!rect) return null;
  // Hidden/detached anchors measure at the origin; do not place against them.
  if (!rect.width && !rect.height && !rect.top && !rect.left) return null;

  const { vw, vh } = viewport();
  const overlay = typeof placement === "string" && placement.indexOf("overlay") === 0;
  const wantTop = typeof placement === "string" && placement.indexOf("top") === 0;
  const alignEnd = typeof placement === "string" && /end$/.test(placement);

  let size = measure(el);

  // After capping height, remeasure before deciding whether to flip.
  const maxH = Math.max(MIN_FLIP_ROOM, vh - 2 * EDGE);
  if (size.h > maxH) {
    el.style.maxHeight = `${Math.round(maxH)}px`;
    size = measure(el);
  }

  const roomBelow = vh - EDGE - (rect.bottom + GAP);
  const roomAbove = rect.top - GAP - EDGE;

  let flipped = false;
  if (overlay) {
    flipped = false;
  } else if (wantTop) {
    flipped = roomAbove >= Math.min(size.h, MIN_FLIP_ROOM);
  } else {
    flipped =
      size.h > roomBelow && roomAbove > roomBelow && roomAbove >= Math.min(size.h, MIN_FLIP_ROOM);
  }

  let top = overlay ? rect.top : flipped ? rect.top - GAP - size.h : rect.bottom + GAP;
  top = Math.max(EDGE, Math.min(top, Math.max(EDGE, vh - EDGE - size.h)));

  let left = alignEnd ? rect.right - size.w : rect.left;
  left = Math.max(EDGE, Math.min(left, Math.max(EDGE, vw - EDGE - size.w)));

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.style.bottom = "auto";
  el.style.right = "auto";
  el.dataset.flip = overlay ? "over" : flipped ? "up" : "down";
  return { top, left, flipped };
}
