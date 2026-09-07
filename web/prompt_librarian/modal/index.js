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
    // The heartbeat also polls widget changes when frontend hooks are unavailable.
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
    // Use the persisted threshold from ping so list and editor checks agree.
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

  // Seed after mounting: the inspector must register its context hooks first.
  syncBinding();

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
  }
  return it.root;
}


export { setHost } from "./host.js";
export { attemptClose, closeModal, isDirty } from "./close.js";
export { getState, setState, subscribe } from "./state.js";
export { popLayer, pushLayer, toast, topLayer, confirmDialog } from "./layers.js";
export { ctx } from "./ctx.js";
export { refreshAll } from "./data.js";
export { getTargetNodeId, loadIntoNode } from "./target.js";
export { isLinked, pushToNode, setLinked } from "./binding.js";
