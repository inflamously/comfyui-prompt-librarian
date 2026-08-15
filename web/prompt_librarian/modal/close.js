/* ==========================================================================
   Prompt Librarian — the dirty guard and teardown
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.
   ========================================================================== */

import { NS } from "../shared/ns.js";
import { h } from "../shared/dom.js";
import { singletonBag } from "../shared/singleton.js";
import { cancelAllLanes } from "../api/lanes.js";
import { focusables } from "./keys.js";
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

/** Inline `Discard unsaved edits?` bar — never window.confirm(). */
function showDirtyBar() {
  const it = inst();
  if (it.dirtyBar) return;
  const bar = h(
    "div",
    {
      className: "pl-dirty",
      role: "status",
      style: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        marginLeft: "auto",
        color: "var(--pl-warn)",
      },
    },
    h("span", null, "Discard unsaved edits?"),
    h(
      "button",
      {
        className: "pl-btn pl-btn-sm pl-btn-danger",
        type: "button",
        onclick: () => {
          hideDirtyBar();
          closeModal();
        },
      },
      "Discard"
    ),
    h(
      "button",
      { className: "pl-btn pl-btn-sm", type: "button", onclick: () => hideDirtyBar() },
      "Keep editing"
    )
  );
  it.dirtyBar = bar;
  it.els.foot.appendChild(bar);
  const btn = focusables(bar)[1];
  if (btn) {
    try {
      btn.focus();
    } catch (_) {
      /* ignore */
    }
  }
}

export function hideDirtyBar() {
  const it = inst();
  if (!it.dirtyBar) return;
  if (it.dirtyBar.parentNode) it.dirtyBar.parentNode.removeChild(it.dirtyBar);
  it.dirtyBar = null;
}

export function attemptClose() {
  if (isDirty()) {
    showDirtyBar();
    return false;
  }
  closeModal();
  return true;
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
  hideDirtyBar();

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
