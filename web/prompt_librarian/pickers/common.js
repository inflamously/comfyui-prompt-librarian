/* modal/input/keys.js intercepts native keys at window capture. Use ctx.onKey
 * or the pl:keydown mirror; native subtree key listeners will not fire.
 * Popover Escape must stop propagation to avoid also closing the modal.
 */

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

/** Bind through the key bus or mirror because capture blocks native subtree events.
 *
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
  el.addEventListener("pl:keydown", onMirror);
  return () => el.removeEventListener("pl:keydown", onMirror);
}
