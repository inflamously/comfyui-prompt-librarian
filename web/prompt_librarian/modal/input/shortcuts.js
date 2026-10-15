import { NS } from "../../shared/ns.js";
import { attemptClose } from "../lifecycle/close.js";
import { onKey } from "../../shared/keys.js";
import { handleTab } from "./focus.js";
import { inst } from "../instance.js";
import { setPane } from "../shell/navigation.js";

/** Use the key bus so shortcuts survive the modal's ComfyUI capture guard. */
export function wireShortcuts() {
  onKey(inst().root, "keydown", onKeyDown);
}

function onKeyDown(event) {
  if (event.key === "Escape" || event.key === "Esc") {
    event.preventDefault();
    if (inst().layers.size) inst().layers.pop();
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
  if (instance.layers.size) return;
  const { inspector } = instance.panes;
  if (typeof inspector?.requestSave !== "function") return;

  if (instance.root.dataset.w === "narrow") setPane("edit");
  Promise.resolve()
    // Ctrl+S creates a new record; the explicit Update action owns overwrites.
    .then(() => inspector.requestSave(true))
    .catch((error) => console.error(`${NS} Ctrl+S save failed`, error));
}
