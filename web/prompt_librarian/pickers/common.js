/* ==========================================================================
   Prompt Librarian — the handful of things every picker needs
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports and `const` data only.

   ==========================================================================
   KEYBOARD: THE ONE THING THAT MUST NOT BE GOT WRONG
   --------------------------------------------------------------------------
   modal/keys.js installs a window-CAPTURE guard that calls
   stopImmediatePropagation() on every keydown/keyup/keypress originating
   inside `.pl-root`. The event therefore NEVER reaches our subtree, and

       el.addEventListener("keydown", fn)     // <-- DEAD CODE inside the modal

   will never fire. There is no such listener anywhere in this directory, and
   adding one would silently break every picker's arrow-key navigation.

   Keys arrive by exactly two supported routes, both used by bindKeys() below:
     1. `ctx.onKey(el, "keydown", fn)` — modal/keys.js re-delivers the ORIGINAL
        event along the path from e.target up to `.pl-root`, honouring
        capture/bubble order, stopPropagation() and preventDefault().
     2. the namespaced mirror CustomEvent `"pl:keydown"`, whose
        `detail.event` is the original. Used only when no ctx is available.

   Escape is handled on the popover element itself (see popover.js) and calls
   stopPropagation() so the modal's root-level Escape handler does not ALSO pop
   a layer — that would close the popover and then the modal.
   ========================================================================== */

import { NS } from "../shared/ns.js";

/* Glyphs built from code points so they survive a wrong/absent charset header. */
export const CHECK = String.fromCharCode(0x2713); // ✓
export const MIDDOT = String.fromCharCode(0x00b7); // ·
export const ZWSP = String.fromCharCode(0x200b); // zero-width space
export const PLUS = "+";

export function isFn(v) {
  return typeof v === "function";
}

export function toast(ctx, message, kind) {
  if (ctx && isFn(ctx.toast)) {
    try {
      ctx.toast(message, { kind: kind || "info" });
      return;
    } catch (_) {
      /* fall through to the console */
    }
  }
  console.info(`${NS} ${message}`);
}

export function viewport() {
  const docEl = typeof document !== "undefined" ? document.documentElement : null;
  const vw =
    (typeof window !== "undefined" && window.innerWidth) || (docEl && docEl.clientWidth) || 1280;
  const vh =
    (typeof window !== "undefined" && window.innerHeight) || (docEl && docEl.clientHeight) || 800;
  return { vw, vh };
}

/** Rendered size of an element, preferring the box the browser actually laid out. */
export function measure(el) {
  let w = 0;
  let ht = 0;
  if (el && isFn(el.getBoundingClientRect)) {
    const r = el.getBoundingClientRect();
    if (r) {
      w = r.width || 0;
      ht = r.height || 0;
    }
  }
  if (!w) w = (el && el.offsetWidth) || 220;
  if (!ht) ht = (el && el.offsetHeight) || 160;
  return { w, h: ht };
}

/**
 * Bind a key handler the only two ways that work inside the modal.
 * NEVER addEventListener("keydown", …) — see the block comment above.
 * @returns {() => void} unbind
 */
export function bindKeys(ctx, el, handler) {
  if (ctx && isFn(ctx.onKey)) {
    try {
      const off = ctx.onKey(el, "keydown", handler);
      if (isFn(off)) return off;
      return () => {};
    } catch (_) {
      /* fall through to the mirrored CustomEvent */
    }
  }
  if (!el || !isFn(el.addEventListener)) return () => {};
  const onMirror = (ev) => {
    const orig = (ev && ev.detail && ev.detail.event) || ev;
    handler(orig);
  };
  // "pl:keydown", NOT "keydown": modal/keys.js dispatches this bubbling mirror
  // after the capture guard has already eaten the real event.
  el.addEventListener("pl:keydown", onMirror);
  return () => el.removeEventListener("pl:keydown", onMirror);
}
