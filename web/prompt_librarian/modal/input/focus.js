import { inst } from "../state.js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return [];
  const out = [];
  for (const el of scope.querySelectorAll(FOCUSABLE)) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") continue;
    if (el.offsetParent === null && el.getAttribute("tabindex") === null) continue;
    out.push(el);
  }
  return out;
}

function trapScope() {
  const it = inst();
  const top = it.layers[it.layers.length - 1];
  return (top && top.el) || it.els.card || it.root;
}

export function handleTab(e) {
  const active = typeof document !== "undefined" ? document.activeElement : null;
  // Do not fight ComfyUI's own dialogs — if focus is inside one, stand down.
  if (active && typeof active.closest === "function" && active.closest(".comfy-modal, .p-dialog")) {
    return;
  }
  const scope = trapScope();
  const list = focusables(scope);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const inScope = active && scope.contains(active);
  if (!inScope) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
