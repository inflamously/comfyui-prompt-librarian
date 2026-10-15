/* Save dirty edits before closing. Keep the modal open unless the inspector
 * returns "saved" or "clean"; conflicts and failed writes must remain visible.
 */

import { NS } from "../../shared/ns.js";
import { singletonBag } from "../../shared/singleton.js";
import { cancelAllLanes } from "../../api/lanes.js";
import { inst } from "../instance.js";
import { setModalVisible } from "../shell/visibility.js";

/** True when the inspector holds unsaved edits. */
export function isDirty() {
  const { inspector } = inst().panes;
  if (typeof inspector?.isDirty !== "function") return false; // inspector not mounted
  try {
    return !!inspector.isDirty();
  } catch (err) {
    console.error(`${NS} isDirty threw`, err);
    return false;
  }
}

/** An emptied editor has nothing to save, and the node already mirrors it, so
 * closing must not wait on a save that can only report "blocked".
 */
function bufferIsEmpty() {
  const ins = inst().panes.inspector;
  if (typeof ins?.getBuffer !== "function") return false;
  try {
    const buf = ins.getBuffer();
    return !String((buf && buf.body) || "").trim();
  } catch (_) {
    return false;
  }
}

function setClosingBusy(on) {
  const it = inst();
  const btn = it.els && it.els.close;
  if (!btn) return;
  try {
    btn.disabled = !!on;
  } catch (_) {
  }
}

/** Return true if closed synchronously; dirty edits close asynchronously only
 * after saved/clean. Other save statuses leave the modal open.
 */
export function attemptClose() {
  const it = inst();
  if (!isDirty() || bufferIsEmpty()) {
    closeModal();
    return true;
  }
  if (it.closing) return false; // Esc mashing must not stack saves

  const { inspector } = it.panes;
  // Missing hooks must not trap the modal; draft persistence is the fallback.
  if (typeof inspector?.requestSave !== "function") {
    closeModal();
    return true;
  }

  const session = it.session;
  it.closing = true;
  setClosingBusy(true);
  Promise.resolve()
    // `true` = save as new: closing must never silently overwrite a stored
    // prompt. Identical text is adopted rather than duplicated (save.js).
    .then(() => inspector.requestSave(true))
    .then((status) => {
      if (it.session === session && (status === "saved" || status === "clean")) closeModal();
    })
    .catch((err) => {
      console.error(`${NS} save on close failed`, err);
    })
    .finally(() => {
      if (it.session !== session) return;
      it.closing = false;
      setClosingBusy(false);
    });
  return false;
}

/** Tear down listeners, timers, requests, and layers; retain only the hidden shell.
 */
export function closeModal() {
  const bag = singletonBag();
  const it = bag.modal;
  if (!it || !it.built || !it.open) return;

  it.open = false;
  it.session = null;
  it.opening = null;
  it.backdropDown = false;
  it.closing = false;
  setClosingBusy(false);

  it.toaster.clear();
  it.layers.clear();

  for (const fn of it.teardown.splice(0)) {
    try {
      fn();
    } catch (err) {
      console.error(`${NS} teardown step failed`, err);
    }
  }

  if (it.ro) {
    try {
      it.ro.disconnect();
    } catch (_) {
    }
    it.ro = null;
  }

  for (const cancel of it.cancelOnClose) {
    try {
      cancel();
    } catch (_) {
    }
  }

  cancelAllLanes();

  // Clear ComfyUI's DOM-based modal gate before returning keyboard focus.
  setModalVisible(false);

  const back = it.previouslyFocused;
  it.previouslyFocused = null;
  if (back && typeof back.focus === "function") {
    try {
      back.focus();
    } catch (_) {
    }
  }
}
