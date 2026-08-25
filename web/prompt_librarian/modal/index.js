/* ==========================================================================
   Prompt Librarian — openModal(), and the modal's public surface
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only: the modal is built on the first
   `openModal()` and never before.

   Feature files under this directory:

     state.js    the singleton instance, the store, the link preference
     keys.js     KEY ISOLATION — read it before touching anything key-related
     layers.js   the layer stack, toasts, the basic confirm
     shell.js    the overlay DOM, its wiring, the responsive switch
     host.js     ComfyUI's `app`, injected by the extension entry
     target.js   target-node resolution and `Load into node`
     binding.js  the node ⇄ panel two-way binding and the link toggle
     drafts.js   sessionStorage drafts
     data.js     taxonomy, header, error reporting
     panes.js    lazy-mounts browse/ and inspector/
     ctx.js      the object every pane is handed
   ========================================================================== */

import { warnOnce } from "../shared/singleton.js";
import { ensureStyles } from "../shared/styles.js";
import { caps } from "../api/caps.js";
import { API } from "../api/routes.js";
import { detachBinding, paintLink, syncBinding } from "./binding.js";
import { loadTaxonomy, paintHeader, reportError } from "./data.js";
import { installKeyGuards } from "./keys.js";
import { mountPanes } from "./panes.js";
import { buildShell, installResponsive, wireShell } from "./shell.js";
import { inst, setModalVisible, setState } from "./state.js";
import { librarianNodes, refreshTarget } from "./target.js";

const HEARTBEAT_MS = 1000;

/**
 * Open the librarian. Idempotent: a second call on an open modal just
 * re-targets and refreshes.
 * @param {{targetNodeId?: any}} [opts]
 */
export async function openModal(opts = {}) {
  if (typeof document === "undefined") return null;
  ensureStyles();
  const it = buildShell();

  if (!it.wired) {
    wireShell();
    it.wired = true;
  }

  // Target: the node that asked, else whatever we had, else the first one.
  let targetId = opts.targetNodeId != null ? opts.targetNodeId : it.state.targetNodeId;
  if (targetId == null) {
    const first = librarianNodes()[0];
    targetId = first ? first.id : null;
  }
  setState({ targetNodeId: targetId }, { silent: true });

  if (!it.open) {
    it.previouslyFocused = document.activeElement;
    setModalVisible(true);
    it.open = true;
    installKeyGuards();
    installResponsive();
    // One timer, two jobs: re-resolve the target node and reconcile the
    // binding with it. syncBinding() also carries node/bind.js's polling
    // backstop, so this is the only thing standing between a frontend we
    // cannot hook and a panel that never updates.
    it.heartbeat = setInterval(() => {
      refreshTarget();
      syncBinding();
    }, HEARTBEAT_MS);
    it.teardown.push(() => {
      clearInterval(it.heartbeat);
      it.heartbeat = 0;
    });
    it.teardown.push(detachBinding);
  }

  refreshTarget();
  paintHeader();
  paintLink();

  // Capabilities first — panes read ctx.caps while mounting.
  try {
    const ping = await API.ping();
    // `/ping` carries the persisted dupe threshold. Ignoring it is why the
    // picker looked inert: the panel booted at 90 % however the store was set.
    const patch = {
      caps: { ...caps },
      rev: (ping && Number(ping.rev)) || it.state.rev,
      storage: (ping && ping.storage) || it.state.storage,
    };
    let t = ping ? Number(ping.threshold) : NaN;
    if (Number.isFinite(t) && t > 0) {
      if (t > 1) t = t / 100; // tolerate a percent-shaped value
      patch.dupes = { ...it.state.dupes, threshold: t };
    }
    setState(patch);
  } catch (err) {
    warnOnce("ping-failed", "ping failed; assuming every capability is present", err && err.message);
  }

  await loadTaxonomy().catch((err) => reportError(err, "taxonomy"));
  await mountPanes();

  // After mountPanes, never before: the seed direction is node -> panel, and
  // there is no panel to seed until the inspector has registered on ctx.
  syncBinding();

  // First paint of the list happens after mount so the source exists.
  try {
    if (it.ctx && it.ctx.list && typeof it.ctx.list.refresh === "function") {
      await it.ctx.list.refresh({ reset: true });
    }
  } catch (err) {
    reportError(err, "search");
  }

  const focusTarget = it.root.querySelector(".pl-search-in") || it.els.card;
  try {
    focusTarget.focus();
  } catch (_) {
    /* ignore */
  }
  return it.root;
}

/* --------------------------------------------------------------------------
   Re-exports — the modal's public surface, so a caller needs one import
   -------------------------------------------------------------------------- */

export { setHost } from "./host.js";
export { attemptClose, closeModal, isDirty } from "./close.js";
export { getState, setState, subscribe } from "./state.js";
export { popLayer, pushLayer, toast, topLayer, confirmDialog } from "./layers.js";
export { ctx } from "./ctx.js";
export { refreshAll } from "./data.js";
export { getTargetNodeId, loadIntoNode } from "./target.js";
export { isLinked, pushToNode, setLinked } from "./binding.js";
