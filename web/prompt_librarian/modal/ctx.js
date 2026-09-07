/* Keep ctx identity stable: panes attach isDirty/requestSave/list/inspector hooks.
 * The optional inspector returns save.js status strings; only "saved" and
 * "clean" permit closing. Do not import it just to compare those statuses.
 */

import * as dom from "../shared/index.js";
import { NS } from "../shared/ns.js";
import { ABORTED, ApiError } from "../api/request.js";
import { lanes } from "../api/lanes.js";
import { caps } from "../api/caps.js";
import { API } from "../api/routes.js";
import { invalidateMeta } from "../api/meta.js";
import { isLinked, pushToNode, setLinked } from "./binding.js";
import { attemptClose, closeModal } from "./close.js";
import { refreshAll, reportError } from "./data.js";
import { clearDraft, loadDraft, saveDraft } from "./drafts.js";
import { hostApp } from "./host.js";
import { onKey } from "./keys.js";
import { choiceDialog, confirmDialog, popLayer, pushLayer, toast, topLayer } from "./layers.js";
import { getState, inst, setState, subscribe } from "./state.js";
import {
  getTargetNodeId,
  librarianNodes,
  loadIntoNode,
  refreshTarget,
  resolveTarget,
} from "./target.js";

export function ctx() {
  const it = inst();
  if (it.ctx) return it.ctx;
  it.ctx = {
    dom,

    API,
    lanes,
    ABORTED,
    ApiError,
    caps,
    invalidateMeta,

    getState,
    setState,
    subscribe,
    get state() {
      return inst().state;
    },

    toast,
    confirmDialog,
    choiceDialog,
    pushLayer,
    popLayer,
    topLayer,
    onKey,
    closeModal,
    attemptClose,
    refreshAll,
    reportError,

    loadIntoNode,
    getTargetNodeId,
    targetNode: resolveTarget,
    librarianNodes,
    refreshTarget,

    pushToNode,
    isLinked,
    setLinked,

    saveDraft,
    loadDraft,
    clearDraft,

    list: null,
    inspector: null,
    /** Push any debounce() from shared/timing.js here; closeModal() cancels them all. */
    debounces: [],

    selectPrompt(id, opts) {
      setState({ currentId: id == null ? null : String(id) });
      const c = inst().ctx;
      const fn =
        (c.inspector && typeof c.inspector.select === "function" && c.inspector.select) ||
        (typeof c.onSelectPrompt === "function" && c.onSelectPrompt) ||
        null;
      if (!fn) return false;
      try {
        fn(id, opts || {});
      } catch (err) {
        console.error(`${NS} selectPrompt failed`, err);
      }
      return true;
    },

    els: it.els,
    get root() {
      return inst().root;
    },
    get app() {
      return hostApp();
    },
  };
  return it.ctx;
}
