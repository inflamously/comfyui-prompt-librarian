/* ==========================================================================
   Prompt Librarian — ctx(), the object handed to every pane
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Always the SAME object, so a pane can attach hooks to it:

     ctx.isDirty       = () => boolean        (inspector — drives close/discard)
     ctx.list          = {refresh, ...}       (browse/ registers itself)
     ctx.inspector     = {select, ...}        (inspector registers itself)
     ctx.onSelectPrompt= (id) => void         (alternative to ctx.inspector)
   ========================================================================== */

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
import { confirmDialog, popLayer, pushLayer, toast, topLayer } from "./layers.js";
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
    // shared/ helpers, handed over so a pane never has to guess the path back
    // to them (inspector/ reads ctx.dom).
    dom,

    // transport
    API,
    lanes,
    ABORTED,
    ApiError,
    caps,
    invalidateMeta,

    // state
    getState,
    setState,
    subscribe,
    get state() {
      return inst().state;
    },

    // chrome
    toast,
    confirmDialog,
    pushLayer,
    popLayer,
    topLayer,
    onKey,
    closeModal,
    attemptClose,
    refreshAll,
    reportError,

    // node
    loadIntoNode,
    getTargetNodeId,
    targetNode: resolveTarget,
    librarianNodes,
    refreshTarget,

    // node binding — see modal/binding.js
    pushToNode,
    isLinked,
    setLinked,

    // drafts
    saveDraft,
    loadDraft,
    clearDraft,

    // panes register themselves here
    list: null,
    inspector: null,
    /** Push any debounce() from shared/timing.js here; closeModal() cancels them all. */
    debounces: [],

    /**
     * Focus a record. Called by browse/ on row activation; delegates to the
     * inspector, and is a safe no-op when the inspector is not mounted.
     */
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

    /** Elements the panes may need (the rail/inspect roots are handed in). */
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
