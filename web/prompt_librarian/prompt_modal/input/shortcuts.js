import { NS } from "../../shared/ns.js";
import { attemptClose } from "../lifecycle/close.js";
import { onKey } from "./keys.js";
import { handleTab } from "./focus.js";
import { popLayer } from "../overlays/layers.js";
import { inst } from "../state.js";
import { setPane } from "../shell/navigation.js";

/** Use the key bus so shortcuts survive the modal's ComfyUI capture guard. */
export function wireShortcuts() {
  onKey(inst().root, "keydown", onKeyDown);
}

function onKeyDown(event) {
  if (event.key === "Escape" || event.key === "Esc") {
    event.preventDefault();
    if (inst().layers.length) popLayer();
    else attemptClose();
    return;
  }

  if (isSaveShortcut(event)) {
    if (!event.repeat) savePrompt();
    return;
  }

  if (event.key === "Tab") handleTab(event);
}

function isSaveShortcut(event) {
  return (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    String(event.key).toLowerCase() === "s";
}

function savePrompt() {
  const instance = inst();
  // A dialog owns save while open; the editor beneath it must not save.
  if (instance.layers.length) return;
  const save = instance.ctx && instance.ctx.requestSave;
  if (typeof save !== "function") return;

  if (instance.root.dataset.w === "narrow") setPane("edit");
  Promise.resolve()
    // Ctrl+S creates a new record; the explicit Update action owns overwrites.
    .then(() => save(true))
    .catch((error) => console.error(`${NS} Ctrl+S save failed`, error));
}
