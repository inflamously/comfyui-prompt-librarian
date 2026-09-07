import { warnOnce } from "../../shared/singleton.js";
import { ensureStyles } from "../../shared/styles.js";
import { caps } from "../../api/caps.js";
import { API } from "../../api/routes.js";
import { detachBinding, syncBinding } from "../target/binding.js";
import { loadTaxonomy, reportError } from "../library/data.js";
import { installKeyGuards } from "../input/keys.js";
import { mountPanes } from "./panes.js";
import { buildShell, wireShell } from "../shell/layout.js";
import { installResponsive } from "../shell/responsive.js";
import { setModalVisible, setState } from "../state.js";
import { librarianNodes, refreshTarget } from "../target/nodes.js";

const HEARTBEAT_MS = 1000;

/**
 * Open/reopen the retained shell. Concurrent calls share initialization and
 * immediately target the latest requested node. Closing invalidates the session;
 * every asynchronous boundary checks it before starting further work.
 * @param {{targetNodeId?: any}} [opts]
 * @returns {Promise<HTMLElement|null>} retained root (also when opening was cancelled)
 */
export async function openModal(opts = {}) {
  if (typeof document === "undefined") return null;
  ensureStyles();
  const it = buildShell();
  wireShell();

  let targetId = opts.targetNodeId != null ? opts.targetNodeId : it.state.targetNodeId;
  if (targetId == null) targetId = librarianNodes()[0]?.id ?? null;
  setState({ targetNodeId: targetId }, { silent: true });

  if (!it.open) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    it.session = { controller };
    it.teardown.push(() => controller?.abort());
    it.previouslyFocused = document.activeElement;
    it.open = true;
    setModalVisible(true);
    installKeyGuards();
    installResponsive();
    it.heartbeat = setInterval(() => {
      refreshTarget();
      if (it.mounted.inspector) syncBinding();
    }, HEARTBEAT_MS);
    it.teardown.push(() => {
      clearInterval(it.heartbeat);
      it.heartbeat = 0;
    }, detachBinding);
  }

  refreshTarget();
  // Retarget an already mounted inspector immediately, even during a refresh.
  if (it.mounted.inspector) syncBinding();
  if (!it.opening) {
    const session = it.session;
    const active = () => it.open && it.session === session;
    const pending = initialize(it, active, session.controller?.signal);
    it.opening = pending;
    try {
      await pending;
    } finally {
      if (it.opening === pending) it.opening = null;
    }
  } else {
    await it.opening;
  }
  return it.root;
}

async function initialize(it, active, signal) {
  try {
    const ping = await API.ping(signal);
    if (!active()) return;
    const patch = {
      caps: { ...caps },
      rev: (ping && Number(ping.rev)) || it.state.rev,
      storage: (ping && ping.storage) || it.state.storage,
    };
    let t = ping ? Number(ping.threshold) : NaN;
    if (Number.isFinite(t) && t > 0) {
      if (t > 1) t /= 100;
      patch.dupes = { ...it.state.dupes, threshold: t };
    }
    setState(patch);
  } catch (err) {
    if (!active()) return;
    warnOnce("ping-failed", "ping failed; assuming every capability is present", err && err.message);
  }
  if (!active()) return;
  await loadTaxonomy(active).catch((err) => { if (active()) reportError(err, "taxonomy"); });
  if (!active()) return;
  await mountPanes(active);
  if (!active()) return;
  syncBinding();
  try {
    if (it.ctx?.list?.refresh) await it.ctx.list.refresh({ reset: true });
  } catch (err) {
    if (active()) reportError(err, "search");
  }
  if (!active()) return;
  const focusTarget = it.root.querySelector(".pl-search-in") || it.els.card;
  try { focusTarget.focus(); } catch (_) { /* detached/unsupported focus */ }
}
