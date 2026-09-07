import { createHeader, wireHeader } from "./header.js";
import { h } from "../../shared/dom.js";
import { ARROW } from "./glyphs.js";
import { inst } from "../state.js";
import { createStorageHint, wireStorageControls } from "../storage/controls.js";

import { wireTargetControls } from "../target/controls.js";
import { wireBackdrop } from "./dismissal.js";
import { wireShortcuts } from "../input/shortcuts.js";

/** Build the retained panel DOM and expose its handles to the modal's panes. */
export function buildShell() {
  const instance = inst();
  if (instance.built) return instance;

  const backdrop = h("div", { className: "pl-backdrop" });
  const header = createHeader();
  const rail = h("div", { className: "pl-rail" });
  const inspect = h("div", { className: "pl-inspect" });
  const body = h(
    "div",
    { className: "pl-body", dataset: { pane: "browse" } },
    rail,
    inspect
  );
  const storageHint = createStorageHint();
  const foot = h(
    "div",
    { className: "pl-foot" },
    h("span", { className: "pl-pill" }, "comfyui-prompt-library"),
    h("span", null, `// output: text ${ARROW}`),
    h("span", { className: "pl-spacer" }),
    storageHint
  );

  // aria-modal is added only while visible; ComfyUI treats hidden dialogs with
  // that attribute as open and would otherwise block workflow shortcuts.
  const card = h(
    "div",
    { className: "pl-card", role: "dialog", "aria-label": "Prompt Library" },
    header.head,
    body,
    foot
  );

  // Fixed popovers need viewport coordinates, outside the card's layout containment.
  const layers = h("div", { className: "pl-layers" });
  const toasts = h("div", { className: "pl-toasts" });
  const root = h(
    "div",
    { className: "pl-root", hidden: true, dataset: { w: "wide" } },
    backdrop,
    card,
    layers,
    toasts
  );

  Object.assign(instance.els, {
    ...header,
    backdrop,
    card,
    body,
    rail,
    inspect,
    foot,
    storageHint,
    layers,
    toasts,
  });
  instance.root = root;
  instance.built = true;
  document.body.appendChild(root);
  return instance;
}


/** Wire once for the retained shell; responsive observers are installed per open. */
export function wireShell() {
  if (inst().wired) return;
  inst().wired = true;
  wireHeader();
  wireTargetControls();
  wireStorageControls();
  wireShortcuts();
  wireBackdrop();
}
