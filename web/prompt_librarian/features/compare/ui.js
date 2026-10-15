/* Small DOM builders the compare dialogs share. */

import { h } from "../../shared/dom.js";
import { str } from "./text.js";

const KINDS = { primary: " pl-btn-primary", accent: " pl-btn-accent", danger: " pl-btn-danger", ghost: " pl-btn-ghost" };

/** A dialog button; disabled ones keep a title saying why. */
export function btn(label, { kind = "", small = true, title = null, disabled = false, key = null, onClick = null } = {}) {
  const el = h("button", {
    className: "pl-btn" + (small ? " pl-btn-sm" : "") + (KINDS[kind] || ""),
    type: "button",
    title,
    disabled: !!disabled,
    dataset: key ? { act: key } : null,
    onclick: onClick,
  }, label);
  if (disabled) el.setAttribute("aria-disabled", "true");
  return el;
}

/** Placeholder lines while a diff loads. */
export function skeleton(lines = 3) {
  const box = h("div", { className: "pl-row-skel", "aria-hidden": "true" });
  for (let i = 0; i < lines; i++) box.append(h("div", { className: "pl-row-body", style: { marginBottom: "8px" } }, " "));
  return box;
}

/** An error message, with a retry button when `onRetry` is given. */
export function errorRow(message, onRetry) {
  const box = h("div", { className: "pl-list-empty", role: "alert" }, str(message));
  if (typeof onRetry === "function") {
    box.append(h("div", { style: { height: "8px" } }), btn("retry", { onClick: onRetry, key: "retry" }));
  }
  return box;
}
