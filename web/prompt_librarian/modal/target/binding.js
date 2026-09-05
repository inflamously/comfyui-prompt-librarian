/* The live link between the modal's editor and its target node's `text` widget.
 *
 *   node -> panel   while linked, edits on the canvas are copied into the
 *                   inspector (watchNodeText + a heartbeat poll)
 *   panel -> node   pushToNode() copies the editor's body (and, for a picked
 *                   record, its prompt_id) onto the node
 *
 * syncBinding() runs on open and on every heartbeat. It re-resolves the target
 * by id, because a retained node object can outlive its deletion from the
 * graph, and re-watches when the target was deleted or replaced.
 *
 * Echo suppression (a push must not bounce back as a node edit) lives in
 * node/text-sync.js, not here.
 */

import { warnOnce } from "../../shared/singleton.js";
import { pollNodeText, readNodeText, watchNodeText, writeNodeText } from "../../node/text-sync.js";
import { hostApp } from "./host.js";
import { inst, setState } from "../state.js";
import { resolveTarget } from "./nodes.js";
import { noteUsage } from "./load.js";
import { writeLinkPref } from "./preferences.js";


/* ---- Link toggle ---------------------------------------------------------- */

export function isLinked() {
  return inst().state.link !== false;
}

/** Turning the link on pulls from the node, since its text is what the
 * workflow renders. Turning it off leaves both sides as they are.
 */
export function setLinked(on) {
  const next = !!on;
  if (inst().state.link === next) return next;
  setState({ link: next });
  writeLinkPref(next);
  syncBinding();
  return next;
}


/* ---- panel -> node -------------------------------------------------------- */

/** Copy the editor's body onto the target node.
 *
 * @param {string} body
 * @param {string} [id] pass it only for a picked record: it relinks the node
 *   and counts as a use. A plain keystroke omits it and leaves the link alone.
 * @returns {{ok: boolean, reason?: string, unchanged?: boolean}} `unchanged`
 *   when the node already shows this, so re-selecting a row is not a new use.
 */
export function pushToNode(body, id) {
  if (!isLinked()) return { ok: false, reason: "unlinked" };
  const node = resolveTarget();
  if (!node) return { ok: false, reason: "stale_target" };

  const values = { body: str(body) };
  if (id !== undefined) values.id = str(id);

  if (nodeAlreadyShows(node, values)) return { ok: true, unchanged: true };

  try {
    const res = writeNodeText(node, values, { canvas: hostCanvas() });
    if (res && res.ok && values.id) noteUsage(values.id, values.body);
    return res;
  } catch (err) {
    warnOnce("bind-outbound", "could not push the panel's text to the node", err);
    return { ok: false, reason: "write_failed" };
  }
}

/** A failed read answers false, so the push still goes through. */
function nodeAlreadyShows(node, values) {
  try {
    const cur = readNodeText(node);
    if (!cur || str(cur.body) !== values.body) return false;
    return values.id === undefined || str(cur.id) === values.id;
  } catch (_) {
    return false;
  }
}


/* ---- node -> panel -------------------------------------------------------- */

function applyNodeTextToPanel(body) {
  const inspector = inst().ctx?.inspector;
  if (typeof inspector?.setBody !== "function") return;
  try {
    inspector.setBody(body, { fromNode: true });
  } catch (err) {
    warnOnce("bind-inbound", "could not apply the node's text to the panel", err);
  }
}


/* ---- Lifecycle ------------------------------------------------------------ */

/** Reconcile the binding with the current target; called on open and on every
 * heartbeat.
 */
export function syncBinding() {
  const it = inst();
  // Wait for the inspector: it is optional, and seeding before it registers
  // would drop the node's initial text on the floor.
  if (!it.open || !isLinked() || !it.ctx?.inspector) {
    detachBinding();
    return;
  }

  const node = resolveTarget();
  if (!node) {
    detachBinding();
    return;
  }
  if (it.binding?.node !== node) attachBinding(node);

  // Backstop for frontends where neither element events nor value
  // interception could be installed.
  if (it.binding) {
    try {
      pollNodeText(it.binding.node);
    } catch (err) {
      warnOnce("bind-poll", "the node-binding poll threw", err);
    }
  }
}

export function detachBinding() {
  const it = inst();
  if (!it.binding) return;
  try {
    it.binding.unwatch();
  } catch (err) {
    warnOnce("bind-detach", "could not detach the node binding", err);
  }
  it.binding = null;
}

/** Watch a new target and seed the panel from it. With no record selected the
 * seed becomes an unsaved edit buffer, never an implicit save.
 */
function attachBinding(node) {
  detachBinding();
  const it = inst();

  let unwatch;
  try {
    unwatch = watchNodeText(node, applyNodeTextToPanel);
  } catch (err) {
    warnOnce("bind-attach", "could not observe the node's text widget", err);
    return;
  }
  it.binding = { nodeId: node.id, node, unwatch };

  try {
    const cur = readNodeText(node);
    if (cur && str(cur.body) !== str(it.state.buffer?.body)) applyNodeTextToPanel(cur.body);
  } catch (err) {
    warnOnce("bind-seed", "could not seed the panel from the node", err);
  }
}


/* ---- Helpers -------------------------------------------------------------- */

function str(v) {
  return v == null ? "" : String(v);
}

function hostCanvas() {
  return hostApp()?.canvas || null;
}
