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
import { isLinked, pushToNode, setLinked } from "./target/binding.js";
import { attemptClose, closeModal } from "./lifecycle/close.js";
import { refreshAll, reportError } from "./library/data.js";
import { clearDraft, loadDraft, saveDraft } from "./library/drafts.js";
import { hostApp } from "./target/host.js";
import { onKey } from "./input/keys.js";
import { choiceDialog, confirmDialog } from "./overlays/dialogs.js";
import { toast } from "./overlays/toasts.js";
import { popLayer, pushLayer, topLayer } from "./overlays/layers.js";
import { getState, inst, setState, subscribe } from "./state.js";
import {
  getTargetNodeId,
  librarianNodes,
  refreshTarget,
  resolveTarget,
} from "./target/nodes.js";

import { loadIntoNode } from "./target/load.js";

/**
 * Stable pane contract, retained across closes and cache-busted imports.
 *
 * Panes consume API/lanes/caps, dom helpers, state access and subscriptions,
 * overlays/onKey, target and binding actions, and JSON draft helpers. `state`,
 * `root` and `app` are live getters; `els` keeps the same shell handles.
 *
 * @typedef {object} PaneContext
 * @property {() => object} getState
 * @property {(patch: object, opts?: {silent?: boolean}) => object} setState
 * @property {(key: string, fn: Function) => Function} subscribe Equal references notify too.
 * @property {{refresh: Function}|null} list Registered by browse; refresh accepts {reset}.
 * @property {{select?: Function, setBody: Function, focusBody?: Function}|null} inspector
 * @property {(() => boolean)=} isDirty Registered by inspector.
 * @property {((asNew: boolean) => Promise<"saved"|"clean"|"blocked"|"failed"|"busy">)=} requestSave
 * @property {Function=} onSelectPrompt Fallback selection hook for older panes.
 * @property {Array<{cancel: Function}>} debounces Cancelled on close; retained for reopen.
 * @returns {PaneContext} The same extensible object on every call; hooks belong to panes.
 */
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
