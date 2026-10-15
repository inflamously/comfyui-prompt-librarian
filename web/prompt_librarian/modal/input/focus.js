import { focusables } from "../../shared/dom.js";
import { inst } from "../instance.js";

function trapScope() {
  const it = inst();
  return it.layers?.top()?.el || it.els.card || it.root;
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
