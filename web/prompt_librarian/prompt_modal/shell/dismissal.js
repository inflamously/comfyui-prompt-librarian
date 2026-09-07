import { h } from "../../shared/dom.js";
import { attemptClose } from "../lifecycle/close.js";
import { TIMES } from "./glyphs.js";
import { popLayer, topLayer } from "../overlays/layers.js";
import { inst } from "../state.js";

export function createCloseButton() {
  // The shell retains this handle so save-on-close can disable it during a save.
  return h(
    "button",
    {
      className: "pl-close",
      type: "button",
      "aria-label": "Close",
      title: "Close (Esc) — unsaved edits are saved first",
      onclick: () => attemptClose(),
    },
    TIMES
  );
}

export function wireBackdrop() {
  const instance = inst();
  const root = instance.root;

  root.addEventListener("pointerdown", (event) => {
    const layer = topLayer();
    if (layer && layer.closeOnOutside && layer.el && !layer.el.contains(event.target)) {
      popLayer(layer);
      return;
    }
    instance.backdropDown = event.target === instance.els.backdrop;
  });

  root.addEventListener("pointerup", (event) => {
    const startedOnBackdrop = instance.backdropDown;
    instance.backdropDown = false;
    // A drag beginning inside the card must never dismiss the panel.
    if (!startedOnBackdrop || event.target !== instance.els.backdrop) return;
    if (instance.layers.length) return;
    attemptClose();
  });
}
