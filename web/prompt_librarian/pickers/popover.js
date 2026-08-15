/* ==========================================================================
   Prompt Librarian — openPopover(), the primitive behind every picker
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { h } from "../shared/dom.js";
import { warnOnce } from "../shared/singleton.js";
import { bindKeys, isFn, measure, viewport } from "./common.js";

const GAP = 6; // px between the anchor and the popover
const EDGE = 8; // px minimum distance to any viewport edge
const MIN_FLIP_ROOM = 96; // never flip into a slot smaller than this

/**
 * Where a popover mounts.
 *
 * `.pl-layers` is a child of `.pl-root` and a SIBLING of `.pl-card`. That is
 * load-bearing, not cosmetic: `.pl-card` sets `contain: layout paint`, which
 * makes it a containing block for `position: fixed` descendants — a popover
 * positioned from getBoundingClientRect() would be offset by the card's
 * origin. Mounting inside `.pl-card` is therefore refused outright.
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
 * @param {HTMLElement} opts.anchor
 * @param {(el: HTMLElement, handle: object) => any} [opts.render]
 * @param {string} [opts.placement] "bottom-start" | "bottom-end" | "top-start" | "top-end"
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
  const offs = [];

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
        /* ignore */
      }
    }
    if (el.parentNode) {
      try {
        el.parentNode.removeChild(el);
      } catch (_) {
        /* ignore */
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
    if (!place(el, anchor, placement)) {
      // No usable anchor. Park it in the top-left corner rather than leaving it
      // at the off-screen measuring position, where it would be invisible.
      el.style.top = `${EDGE}px`;
      el.style.left = `${EDGE}px`;
    }
  }

  // ---- mount --------------------------------------------------------------
  // Exactly one owner of the outside-click behaviour. With a ctx we hand the
  // element to the modal's layer stack (closeOnOutside:true) and install NO
  // document listener of our own: two owners race, and the modal would then see
  // an empty layer stack on pointerup and close the whole modal.
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
      if (anchor && isFn(anchor.contains) && anchor.contains(t)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    offs.push(() => document.removeEventListener("pointerdown", onDown, true));
  }

  // ---- content ------------------------------------------------------------
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

  // ---- keys ---------------------------------------------------------------
  // Escape is stopped here so the modal's root handler does not pop a second
  // layer (with no layers left it calls attemptClose() and the MODAL closes).
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

  // ---- scroll / resize ----------------------------------------------------
  // A fixed popover does not follow a scrolling ancestor, so it is dismissed
  // rather than left hanging next to nothing. `capture: true` catches scroll on
  // any ancestor (scroll events do not bubble).
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

/**
 * Place `el` against `anchor`: prefer below, flip above on bottom overflow
 * when there is room, clamp both axes into the viewport, and cap the height
 * when nothing fits.
 */
function place(el, anchor, placement) {
  if (!el || !anchor || !isFn(anchor.getBoundingClientRect)) return null;
  let rect;
  try {
    rect = anchor.getBoundingClientRect();
  } catch (_) {
    return null;
  }
  if (!rect) return null;

  const { vw, vh } = viewport();
  const wantTop = typeof placement === "string" && placement.indexOf("top") === 0;
  const alignEnd = typeof placement === "string" && /end$/.test(placement);

  let size = measure(el);

  // Nothing fits anywhere: cap the height and re-measure once, so the flip
  // decision below is made against the size we will actually render.
  const maxH = Math.max(MIN_FLIP_ROOM, vh - 2 * EDGE);
  if (size.h > maxH) {
    el.style.maxHeight = `${Math.round(maxH)}px`;
    size = measure(el);
  }

  const roomBelow = vh - EDGE - (rect.bottom + GAP);
  const roomAbove = rect.top - GAP - EDGE;

  let flipped = false;
  if (wantTop) {
    flipped = roomAbove >= Math.min(size.h, MIN_FLIP_ROOM);
  } else {
    // Overflows the bottom AND there is more usable room above → flip.
    flipped =
      size.h > roomBelow && roomAbove > roomBelow && roomAbove >= Math.min(size.h, MIN_FLIP_ROOM);
  }

  let top = flipped ? rect.top - GAP - size.h : rect.bottom + GAP;
  top = Math.max(EDGE, Math.min(top, Math.max(EDGE, vh - EDGE - size.h)));

  let left = alignEnd ? rect.right - size.w : rect.left;
  left = Math.max(EDGE, Math.min(left, Math.max(EDGE, vw - EDGE - size.w)));

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.style.bottom = "auto";
  el.style.right = "auto";
  el.dataset.flip = flipped ? "up" : "down";
  return { top, left, flipped };
}
