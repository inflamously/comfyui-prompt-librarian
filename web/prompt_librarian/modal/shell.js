/* ==========================================================================
   Prompt Librarian — the overlay DOM and its one-time wiring
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only. The shell is built on the first
   `openModal()` and never before.

   Owns the header / rail / inspector / footer / layers / toasts skeleton, the
   header's target picker, the click-outside and Escape wiring, and the
   responsive wide/narrow switch.
   ========================================================================== */

import { h } from "../shared/dom.js";
import { warnOnce } from "../shared/singleton.js";
import { ARROW, CARET, LINKED, TIMES } from "./glyphs.js";
import { attemptClose } from "./close.js";
import { isLinked, setLinked, syncBinding } from "./binding.js";
import { handleTab, onKey } from "./keys.js";
import { popLayer, pushLayer, topLayer } from "./layers.js";
import { inst, setState } from "./state.js";
import { librarianNodes, nodeLabel, refreshTarget } from "./target.js";

const NARROW_AT = 900;

/* --------------------------------------------------------------------------
   Construction
   -------------------------------------------------------------------------- */

export function buildShell() {
  const it = inst();
  if (it.built) return it;

  const els = it.els;

  const backdrop = h("div", { className: "pl-backdrop" });

  const target = h(
    "button",
    {
      className: "pl-target",
      type: "button",
      "aria-haspopup": "listbox",
      onclick: () => openTargetPicker(),
    },
    h("span", null, `${ARROW} ${CARET}`)
  );

  // The link toggle sits immediately left of the target chip: the two read as
  // one statement — "mirroring ⇅ node #12".
  const link = h(
    "button",
    {
      className: "pl-link",
      type: "button",
      "aria-pressed": "true",
      "aria-label": "Mirror the editor and the node",
      onclick: () => setLinked(!isLinked()),
    },
    h("span", null, `${LINKED} linked`)
  );

  const seg = h(
    "div",
    { className: "pl-seg", role: "tablist", "aria-label": "Pane", style: { flex: "1 1 100%", order: "6" } },
    h(
      "button",
      {
        className: "pl-seg-tab",
        type: "button",
        role: "tab",
        "aria-selected": "true",
        onclick: () => setPane("browse"),
      },
      "Browse"
    ),
    h(
      "button",
      {
        className: "pl-seg-tab",
        type: "button",
        role: "tab",
        "aria-selected": "false",
        onclick: () => setPane("edit"),
      },
      "Edit"
    )
  );

  const sub = h("div", { className: "pl-sub" }, "");

  const head = h(
    "div",
    { className: "pl-head" },
    h("div", { className: "pl-dot" }),
    h("div", { className: "pl-title" }, "Prompt Library"),
    sub,
    h("div", { className: "pl-spacer" }),
    link,
    target,
    h(
      "button",
      {
        className: "pl-close",
        type: "button",
        "aria-label": "Close",
        title: "Close (Esc)",
        onclick: () => attemptClose(),
      },
      TIMES
    ),
    seg
  );

  const rail = h("div", { className: "pl-rail" });
  const inspect = h("div", { className: "pl-inspect" });
  const body = h("div", { className: "pl-body", dataset: { pane: "browse" } }, rail, inspect);

  const foot = h(
    "div",
    { className: "pl-foot" },
    h("span", { className: "pl-pill" }, "comfyui-prompt-library"),
    h("span", null, `// output: text ${ARROW}`)
  );

  const card = h("div", { className: "pl-card", role: "dialog", "aria-modal": "true", "aria-label": "Prompt Library" }, head, body, foot);

  // .pl-layers and .pl-toasts are children of .pl-root and SIBLINGS of
  // .pl-card. That is not cosmetic: .pl-card sets `contain: layout paint`,
  // which makes it a containing block for `position: fixed` descendants — a
  // popover positioned from getBoundingClientRect would be offset by the
  // card's origin. See the note on .pl-card in librarian.css.
  const layers = h("div", { className: "pl-layers" });
  const toasts = h("div", { className: "pl-toasts" });

  const root = h(
    "div",
    { className: "pl-root", hidden: true, dataset: { w: "wide" } },
    backdrop,
    card,
    layers,
    toasts
  );

  Object.assign(els, { backdrop, card, head, sub, link, target, seg, body, rail, inspect, foot, layers, toasts });
  it.root = root;
  it.built = true;

  document.body.appendChild(root);
  return it;
}

export function setPane(which) {
  const it = inst();
  if (!it.built) return;
  it.els.body.dataset.pane = which;
  const tabs = it.els.seg.querySelectorAll('[role="tab"]');
  if (tabs[0]) tabs[0].setAttribute("aria-selected", which === "browse" ? "true" : "false");
  if (tabs[1]) tabs[1].setAttribute("aria-selected", which === "edit" ? "true" : "false");
}

/* --------------------------------------------------------------------------
   The header's target picker
   -------------------------------------------------------------------------- */

function openTargetPicker() {
  const it = inst();
  const nodes = librarianNodes();
  const list = h("div", { className: "pl-popover", role: "listbox", "aria-label": "Target node" });
  if (!nodes.length) {
    list.appendChild(h("div", { className: "pl-opt", "aria-disabled": "true" }, "add a Prompt Librarian node first"));
  }
  for (const node of nodes) {
    const selected = String(node.id) === String(it.state.targetNodeId);
    list.appendChild(
      h(
        "button",
        {
          className: "pl-opt",
          type: "button",
          role: "option",
          "aria-selected": selected ? "true" : "false",
          onclick: () => {
            setState({ targetNodeId: node.id });
            refreshTarget();
            // Re-point the binding at the node the user just chose, and seed
            // the panel from it — same rule as on open: the node wins on
            // connect, because it is what will actually render.
            syncBinding();
            popLayer(handle);
          },
        },
        nodeLabel(node)
      )
    );
  }
  // Positioned from viewport coordinates. This works only because .pl-layers
  // is a sibling of .pl-card — .pl-card has `contain: layout paint`, which
  // makes it a containing block for position:fixed and would offset us.
  const rect = it.els.target.getBoundingClientRect();
  list.style.top = `${Math.round(rect.bottom + 6)}px`;
  list.style.left = `${Math.round(rect.left)}px`;
  const handle = pushLayer({ el: list, closeOnOutside: true });
}

/* --------------------------------------------------------------------------
   Shell wiring — one-time listeners
   -------------------------------------------------------------------------- */

export function wireShell() {
  const it = inst();
  const root = it.root;

  // ---- Escape + Tab, through the key bus (see modal/keys.js) -------------
  onKey(root, "keydown", (e) => {
    if (e.key === "Escape" || e.key === "Esc") {
      // Escape is the ONE key we are allowed to preventDefault.
      e.preventDefault();
      if (it.layers.length) popLayer();
      else attemptClose();
      return;
    }
    if (e.key === "Tab") handleTab(e);
  });

  // ---- Click-outside ------------------------------------------------------
  // Both pointerdown AND pointerup must land on the backdrop. Without that a
  // drag-select started inside the list and released over the backdrop closes
  // the modal and throws away the edit.
  root.addEventListener("pointerdown", (e) => {
    const top = topLayer();
    if (top && top.closeOnOutside && top.el && !top.el.contains(e.target)) {
      popLayer(top);
      return;
    }
    it.backdropDown = e.target === it.els.backdrop;
  });
  root.addEventListener("pointerup", (e) => {
    const down = it.backdropDown;
    it.backdropDown = false;
    if (!down || e.target !== it.els.backdrop) return;
    if (it.layers.length) return;
    attemptClose();
  });
}

/* --------------------------------------------------------------------------
   Responsive — installed per open, torn down on close
   --------------------------------------------------------------------------
   NOT part of wireShell(): closeModal() disconnects the observer and drains
   the teardown list, so anything installed once at build time would be dead
   after the first close.
   -------------------------------------------------------------------------- */

export function installResponsive() {
  const it = inst();
  const root = it.root;

  const applyWidth = (w) => {
    const mode = w < NARROW_AT ? "narrow" : "wide";
    if (root.dataset.w === mode) return;
    root.dataset.w = mode;
    // The contract asks for it on the card; the stylesheet keys off the root.
    if (it.els.card) it.els.card.dataset.w = mode;
    if (mode === "wide") it.els.body.dataset.pane = "browse";
  };
  // The ROOT is measured, not the card: narrow mode removes the root's 24px
  // padding, which widens the card — measuring the card would oscillate
  // across the threshold. The root is `position: fixed; inset: 0`, so its
  // width is the viewport's and is unaffected by the mode we set.
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = (entry.contentRect && entry.contentRect.width) || root.clientWidth || 0;
        applyWidth(w);
      }
    });
    try {
      ro.observe(root);
      it.ro = ro;
    } catch (err) {
      warnOnce("resize-observer", "ResizeObserver.observe failed; falling back to window resize", err);
      it.ro = null;
    }
  }
  if (!it.ro) {
    const onResize = () => applyWidth(root.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1200));
    if (typeof window !== "undefined") window.addEventListener("resize", onResize);
    it.teardown.push(() => {
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
    });
    onResize();
  } else {
    applyWidth(root.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1200));
  }
}
