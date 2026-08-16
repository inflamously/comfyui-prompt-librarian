/* ==========================================================================
   NODE BINDING — the textarea and the node's `text` widget as one model
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Direction              Trigger                        Path
   ---------------------  -----------------------------  ---------------------
   node  -> textarea      node/bind.js layers A/B/C      onNodeText() below
   textarea -> node       inspector afterEdit()          ctx.pushToNode()
   record   -> node       inspector adoptRecord({push})  ctx.pushToNode()

   Two rules keep this from becoming a mess:

   1. ONE echo guard, and it lives in node/bind.js (`lastSeen`). Nothing here
      tracks "did I just write that" — every layer already agrees on one
      answer.

   2. The binding is attached to a NODE OBJECT but keyed by ID.
      `resolveTarget` re-resolves by id on every call precisely because holding
      a reference survives the node being deleted; the binding must not
      reintroduce the bug that guards against. Hence `syncBinding()` runs on
      the heartbeat and re-attaches whenever the resolved node is no longer the
      bound one.
   ========================================================================== */

import { cls } from "../shared/dom.js";
import { warnOnce } from "../shared/singleton.js";
import { bindNode, poll as pollNode, readNodeText, writeNodeText } from "../node/bind.js";
import { BROKEN, LINKED } from "./glyphs.js";
import { hostApp } from "./host.js";
import { inst, setState, writeLinkPref } from "./state.js";
import { resolveTarget } from "./target.js";

export function isLinked() {
  return inst().state.link !== false;
}

/**
 * Toggle the binding. Turning it ON immediately pulls the node's text into the
 * panel (the node is the thing that will actually render, so it wins on
 * connect); turning it OFF leaves both sides exactly as they are.
 */
export function setLinked(on) {
  const next = !!on;
  if (inst().state.link === next) return next;
  setState({ link: next });
  writeLinkPref(next);
  syncBinding();
  paintLink();
  return next;
}

/** Inbound: the node's text changed under us. */
function onNodeText(body) {
  const insp = inst().ctx && inst().ctx.inspector;
  if (!insp || typeof insp.setBody !== "function") return;
  try {
    insp.setBody(body, { fromNode: true });
  } catch (err) {
    warnOnce("bind-inbound", "could not apply the node's text to the panel", err);
  }
}

/**
 * Outbound: push the panel's text (and optionally a record link) to the node.
 * A no-op when unlinked — every caller may call it unconditionally.
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
    return writeNodeText(node, values, { canvas: hostApp() && hostApp().canvas });
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

/**
 * Attach to the current target and seed the panel FROM THE NODE.
 *
 * The seeding direction is deliberate and is the specific fix for "the panel
 * shows something else than the node". On connect the node wins: it holds what
 * will actually render, and it is what the user was just looking at. With no
 * record selected this leaves the node's prompt in the textarea as an unsaved
 * buffer, which is the right affordance — `Save as new` is right there.
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

  // Seed: node -> panel, but only when they actually disagree.
  try {
    const cur = readNodeText(node);
    const buf = it.state.buffer || {};
    if (cur && String(cur.body) !== String(buf.body == null ? "" : buf.body)) onNodeText(cur.body);
  } catch (err) {
    warnOnce("bind-seed", "could not seed the panel from the node", err);
  }
}

/**
 * Reconcile the binding with the current link setting and target. Cheap and
 * idempotent — safe to call from the heartbeat, which is exactly what makes
 * a re-targeted or re-created node get picked up without its own hook.
 */
export function syncBinding() {
  const it = inst();
  if (!it.open || !isLinked()) {
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

/** Repaint the link chip from state. */
export function paintLink() {
  const it = inst();
  const chip = it.els && it.els.link;
  if (!chip) return;
  const on = isLinked();
  cls(chip, "is-on", on);
  chip.setAttribute("aria-pressed", on ? "true" : "false");
  const span = chip.firstChild;
  if (span) span.textContent = on ? `${LINKED} linked` : `${BROKEN} unlinked`;
  chip.title = on
    ? "The editor and the node's text mirror each other, and picking a prompt " +
      "loads it straight into the node. Click to work on the library without " +
      "touching the node."
    : "The editor and the node are independent — browsing, editing and saving " +
      "library records leaves the node alone. Click to mirror them again.";
}
