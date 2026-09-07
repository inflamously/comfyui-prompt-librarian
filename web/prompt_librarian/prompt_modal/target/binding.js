/* node/bind.js owns the shared lastSeen echo guard.
 * Re-resolve the target by ID and rebind on heartbeat: a retained node object
 * can outlive its deletion from the graph.
 */

import { warnOnce } from "../../shared/singleton.js";
import { bindNode, poll as pollNode, readNodeText, writeNodeText } from "../../node/bind.js";
import { hostApp } from "./host.js";
import { inst, setState } from "../state.js";
import { resolveTarget } from "./nodes.js";
import { noteUsage } from "./load.js";
import { writeLinkPref } from "./preferences.js";

export function isLinked() {
  return inst().state.link !== false;
}

/** On connect, pull from the node: its text is what the workflow renders.
 * Disconnecting leaves both values intact.
 */
export function setLinked(on) {
  const next = !!on;
  if (inst().state.link === next) return next;
  setState({ link: next });
  writeLinkPref(next);
  syncBinding();
  return next;
}

function onNodeText(body) {
  const insp = inst().ctx && inst().ctx.inspector;
  if (!insp || typeof insp.setBody !== "function") return;
  try {
    insp.setBody(body, { fromNode: true });
  } catch (err) {
    warnOnce("bind-inbound", "could not apply the node's text to the panel", err);
  }
}

/** No-op when unlinked; report unchanged so re-selection does not count a load.
 *
 * @param {string} body
 * @param {string} [id] only written when passed; omitting it leaves the link
 *   alone, which is what a plain keystroke should do.
 */
export function pushToNode(body, id) {
  if (!isLinked()) return { ok: false, reason: "unlinked" };
  const node = resolveTarget();
  if (!node) return { ok: false, reason: "stale_target" };
  const values = { body: body == null ? "" : String(body) };
  if (id !== undefined) values.id = id == null ? "" : String(id);
  try {
    const cur = readNodeText(node);
    if (
      cur &&
      String(cur.body) === values.body &&
      (values.id === undefined || String(cur.id || "") === values.id)
    ) {
      return { ok: true, unchanged: true };
    }
  } catch (_) {
    /* fall through and write — a failed compare must never block the push */
  }
  try {
    const res = writeNodeText(node, values, { canvas: hostApp() && hostApp().canvas });
    // An id is only ever passed on a record push (a row the user picked), so
    // this is the selection half of usage counting; keystrokes never count.
    if (res && res.ok && values.id) noteUsage(values.id, values.body);
    return res;
  } catch (err) {
    warnOnce("bind-outbound", "could not push the panel's text to the node", err);
    return { ok: false, reason: "write_failed" };
  }
}

export function detachBinding() {
  const it = inst();
  if (!it.binding) return;
  try {
    it.binding.unbind();
  } catch (err) {
    warnOnce("bind-detach", "could not detach the node binding", err);
  }
  it.binding = null;
}

/** Seed from the node on connect. With no selected record, this becomes an
 * unsaved edit buffer rather than an implicit save.
 */
function attachBinding() {
  const it = inst();
  const node = resolveTarget();
  if (!node) {
    detachBinding();
    return;
  }
  if (it.binding && it.binding.node === node) return;
  detachBinding();

  let unbind;
  try {
    unbind = bindNode(node, onNodeText);
  } catch (err) {
    warnOnce("bind-attach", "could not observe the node's text widget", err);
    return;
  }
  it.binding = { nodeId: node.id, node, unbind };

  try {
    const cur = readNodeText(node);
    const buf = it.state.buffer || {};
    if (cur && String(cur.body) !== String(buf.body == null ? "" : buf.body)) onNodeText(cur.body);
  } catch (err) {
    warnOnce("bind-seed", "could not seed the panel from the node", err);
  }
}

/** Reconcile target identity on heartbeat to handle deletion and replacement.
 */
export function syncBinding() {
  const it = inst();
  // Do not consume the initial node seed before the optional inspector registers.
  if (!it.open || !isLinked() || !it.ctx?.inspector) {
    detachBinding();
    return;
  }
  attachBinding();
  // Layer C: the polling backstop, for frontends where neither the element
  // listener nor the value interception could be installed.
  if (it.binding) {
    try {
      pollNode(it.binding.node);
    } catch (err) {
      warnOnce("bind-poll", "the node-binding poll threw", err);
    }
  }
}

