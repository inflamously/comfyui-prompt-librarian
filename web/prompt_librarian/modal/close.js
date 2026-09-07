/* Save dirty edits before closing. Keep the modal open unless the inspector
 * returns "saved" or "clean"; conflicts and failed writes must remain visible.
 */

import { NS } from "../shared/ns.js";
import { singletonBag } from "../shared/singleton.js";
import { cancelAllLanes } from "../api/lanes.js";
import { popLayer } from "./layers.js";
import { inst, setModalVisible } from "./state.js";

export function isDirty() {
  const it = inst();
  const fn = it.ctx && it.ctx.isDirty;
  if (typeof fn !== "function") return false; // inspector not mounted
  try {
    return !!fn();
  } catch (err) {
    console.error(`${NS} isDirty threw`, err);
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
  if (!isDirty()) {
    closeModal();
    return true;
  }
  if (it.closing) return false; // Esc mashing must not stack saves

  const save = it.ctx && it.ctx.requestSave;
  // Missing hooks must not trap the modal; draft persistence is the fallback.
  if (typeof save !== "function") {
    closeModal();
    return true;
  }

  it.closing = true;
  setClosingBusy(true);
  Promise.resolve()
    // `true` = save as new: closing must never silently overwrite a stored
    // prompt. Identical text is adopted rather than duplicated (save.js).
    .then(() => save(true))
    .then((status) => {
      if (status === "saved" || status === "clean") closeModal();
    })
    .catch((err) => {
      console.error(`${NS} save on close failed`, err);
    })
    .finally(() => {
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
  it.closing = false;
  setClosingBusy(false);

  while (it.layers.length) popLayer(it.layers[it.layers.length - 1]);

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

  const c = it.ctx;
  if (c && Array.isArray(c.debounces)) {
    for (const d of c.debounces) {
      try {
        if (d && typeof d.cancel === "function") d.cancel();
      } catch (_) {
      }
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
