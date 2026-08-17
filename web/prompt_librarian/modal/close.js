/* ==========================================================================
   Prompt Librarian — save-on-close and teardown
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Closing NEVER strands the user. There used to be a `Discard unsaved edits?`
   bar here that refused to close and made you choose between losing the edit
   and staying put; every close path hit it, so a dirty buffer meant the modal
   could not be dismissed at all. Now a dirty buffer is simply saved first.

   The save goes through the ordinary inspector flow (ctx.requestSave), which
   means the two gates in inspector/save.js still stand: a record changed
   elsewhere, or a near-duplicate, opens its dialog and the modal STAYS OPEN.
   Those are the only cases where closing could silently corrupt the library,
   and they are the only cases that still interrupt.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { singletonBag } from "../shared/singleton.js";
import { cancelAllLanes } from "../api/lanes.js";
import { popLayer } from "./layers.js";
import { inst } from "./state.js";

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

/**
 * The close button, disabled while a save-on-close is in flight. The save runs
 * a staleness GET and a duplicate POST before it can commit, so without this
 * the button reads as broken for the length of a round trip.
 */
function setClosingBusy(on) {
  const it = inst();
  const btn = it.els && it.els.close;
  if (!btn) return;
  try {
    btn.disabled = !!on;
  } catch (_) {
    /* ignore */
  }
}

/**
 * Close, saving first when there is anything to save.
 *
 * Returns true only when the modal is already gone. A dirty buffer makes this
 * ASYNCHRONOUS: it returns false and closes later, once ctx.requestSave() has
 * reported "saved" or "clean". "blocked" means the save flow put a decision on
 * screen (remote change / duplicate) and the modal must stay. No current
 * caller reads the return value.
 */
export function attemptClose() {
  const it = inst();
  if (!isDirty()) {
    closeModal();
    return true;
  }
  if (it.closing) return false; // Esc mashing must not stack saves

  const save = it.ctx && it.ctx.requestSave;
  // Dirty with no save hook should be impossible — inspector/index.js
  // registers both in one block — but an undismissable modal is worse than a
  // lost buffer, and the sessionStorage draft still holds the text.
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

/**
 * Close and dismantle everything that could outlive the modal: both key
 * layers, the ResizeObserver, the heartbeat, every debounce, every lane, the
 * layer stack. The DOM itself is kept and hidden — rebuilding it on every open
 * costs a frame for nothing.
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
      /* ignore */
    }
    it.ro = null;
  }

  // Panes register their debounces here so one loop cancels them all.
  const c = it.ctx;
  if (c && Array.isArray(c.debounces)) {
    for (const d of c.debounces) {
      try {
        if (d && typeof d.cancel === "function") d.cancel();
      } catch (_) {
        /* ignore */
      }
    }
  }

  cancelAllLanes();

  it.root.hidden = true;

  const back = it.previouslyFocused;
  it.previouslyFocused = null;
  if (back && typeof back.focus === "function") {
    try {
      back.focus();
    } catch (_) {
      /* ignore */
    }
  }
}
