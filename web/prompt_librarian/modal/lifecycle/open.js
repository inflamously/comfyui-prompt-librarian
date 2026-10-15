import { warnOnce } from "../../shared/singleton.js";
import { ensureStyles } from "../../shared/styles.js";
import { caps } from "../../api/caps.js";
import { API } from "../../api/routes.js";
import { detachBinding, syncBinding } from "../target/binding.js";
import { applyRemoteChange, loadTaxonomy, reportError } from "../library.js";
import { onLibraryChanged } from "../../api/request.js";
import { installKeyGuards } from "../../shared/keys.js";
import { mountPanes } from "../app.js";
import { buildShell, wireShell } from "../shell/layout.js";
import { setModalVisible } from "../shell/visibility.js";
import { installResponsive } from "../shell/responsive.js";
import { slice } from "../instance.js";
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

  const shell = slice("shell");
  let targetId = opts.targetNodeId != null ? opts.targetNodeId : shell.get("targetNodeId");
  if (targetId == null) targetId = librarianNodes()[0]?.id ?? null;
  shell.set({ targetNodeId: targetId });

  if (!it.open) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    it.session = { controller };
    it.teardown.push(() => controller?.abort());
    it.previouslyFocused = document.activeElement;
    it.open = true;
    setModalVisible(true);
    it.teardown.push(installKeyGuards(it.root));
    // Another tab or a workflow run wrote to the library: show it here too.
    it.teardown.push(onLibraryChanged((detail) => applyRemoteChange(detail)));
    installResponsive();
    it.heartbeat = setInterval(() => {
      refreshTarget();
      if (it.panes.inspector) syncBinding();
    }, HEARTBEAT_MS);
    it.teardown.push(() => {
      clearInterval(it.heartbeat);
      it.heartbeat = 0;
    }, detachBinding);
  }

  refreshTarget();
  // Retarget an already mounted inspector immediately, even during a refresh.
  if (it.panes.inspector) syncBinding();
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
    const library = slice("library");
    const storage = slice("storage");
    library.set({ caps: { ...caps }, rev: (ping && Number(ping.rev)) || library.get("rev") });
    storage.set({ storage: (ping && ping.storage) || storage.get("storage") });
    let t = ping ? Number(ping.threshold) : NaN;
    if (Number.isFinite(t) && t > 0) slice("dupes").set({ threshold: t > 1 ? t / 100 : t });
  } catch (err) {
    if (!active()) return;
    warnOnce("ping-failed", "ping failed; assuming every capability is present", err && err.message);
  }
  if (!active()) return;
  await loadTaxonomy(active).catch((err) => { if (active()) reportError(err, "taxonomy"); });
  if (!active()) return;
  mountPanes();
  syncBinding();
  try {
    await it.panes.list?.refresh({ reset: true });
  } catch (err) {
    if (active()) reportError(err, "search");
  }
  if (!active()) return;
  const focusTarget = it.root.querySelector(".pl-search-in") || it.els.card;
  try { focusTarget.focus(); } catch (_) { /* detached/unsupported focus */ }
}
