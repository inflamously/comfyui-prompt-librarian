import { cls, h } from "../../shared/dom.js";
import { isLinked, setLinked, syncBinding } from "./binding.js";
import { ARROW, CARET, BROKEN, LINKED } from "../shell/glyphs.js";
import { popLayer, pushLayer } from "../overlays/layers.js";
import { inst, setState, subscribe } from "../state.js";
import { librarianNodes, nodeLabel, refreshTarget } from "./nodes.js";

export function createTargetButton() {
  return h(
    "button",
    {
      className: "pl-target",
      type: "button",
      "aria-haspopup": "listbox",
      onclick: openTargetPicker,
    },
    h("span", null, `${ARROW} ${CARET}`)
  );
}

function openTargetPicker() {
  const instance = inst();
  const nodes = librarianNodes();
  const list = h(
    "div",
    { className: "pl-popover", role: "listbox", "aria-label": "Target node" }
  );
  if (!nodes.length) {
    list.appendChild(h(
      "div",
      { className: "pl-opt", "aria-disabled": "true" },
      "add a Prompt Librarian node first"
    ));
  }

  for (const node of nodes) {
    const selected = String(node.id) === String(instance.state.targetNodeId);
    list.appendChild(h(
      "button",
      {
        className: "pl-opt",
        type: "button",
        role: "option",
        "aria-selected": String(selected),
        onclick: () => {
          setState({ targetNodeId: node.id });
          refreshTarget();
          // Seed the new binding from the node's rendered text.
          syncBinding();
          popLayer(handle);
        },
      },
      nodeLabel(node)
    ));
  }

  const bounds = instance.els.target.getBoundingClientRect();
  list.style.top = `${Math.round(bounds.bottom + 6)}px`;
  list.style.left = `${Math.round(bounds.left)}px`;
  const handle = pushLayer({ el: list, closeOnOutside: true });
}

export function paintTarget(state) {
  const target = state.target || {};
  const ok = state.targetOk;
  const chip = inst().els.target;
  if (!chip) return;
  cls(chip, "is-stale", !ok);
  const text = ok
    ? `${ARROW} ${target.label} ${CARET}`
    : target.hasNodes
    ? `${ARROW} pick a node ${CARET}`
    : `${ARROW} no Librarian node ${CARET}`;
  const span = chip.firstChild;
  if (span) span.textContent = text;
  chip.title = ok
    ? "The editor mirrors this node. Click to target a different one."
    : target.hasNodes
    ? "The targeted node is gone. Click to pick another; everything else still works."
    : "add a Prompt Librarian node first";
  chip.disabled = false;
}


export function paintLink(state) {
  const it = inst();
  const chip = it.els && it.els.link;
  if (!chip) return;
  const on = state.link !== false;
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

export function wireTargetControls() {
  subscribe("target", paintTarget);
  subscribe("targetOk", paintTarget);
  subscribe("link", paintLink);
  paintTarget(inst().state);
  paintLink(inst().state);
}

export function createLinkButton() {
  return h("button", {
    className: "pl-link", type: "button", "aria-pressed": "true",
    "aria-label": "Mirror the editor and the node",
    onclick: () => setLinked(!isLinked()),
  }, h("span", null, `${LINKED} linked`));
}
