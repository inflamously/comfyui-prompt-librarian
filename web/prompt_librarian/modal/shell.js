import { h } from "../shared/dom.js";
import { NS } from "../shared/ns.js";
import { warnOnce } from "../shared/singleton.js";
import { ARROW, CARET, LINKED, TIMES } from "./glyphs.js";
import { attemptClose } from "./close.js";
import { isLinked, setLinked, syncBinding } from "./binding.js";
import { handleTab, onKey } from "./keys.js";
import { popLayer, pushLayer, topLayer } from "./layers.js";
import { inst, setState } from "./state.js";
import { librarianNodes, nodeLabel, refreshTarget } from "./target.js";

const NARROW_AT = 900;


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

  // Retain the close button so save-on-close can disable it during the request.
  const closeBtn = h(
    "button",
    {
      className: "pl-close",
      type: "button",
      "aria-label": "Close",
      title: "Close (Esc) — unsaved edits are saved first",
      onclick: () => attemptClose(),
    },
    TIMES
  );

  const head = h(
    "div",
    { className: "pl-head" },
    h("div", { className: "pl-dot" }),
    h("div", { className: "pl-title" }, "Prompt Library"),
    sub,
    h("div", { className: "pl-spacer" }),
    link,
    target,
    closeBtn,
    seg
  );

  const rail = h("div", { className: "pl-rail" });
  const inspect = h("div", { className: "pl-inspect" });
  const body = h("div", { className: "pl-body", dataset: { pane: "browse" } }, rail, inspect);

  const storageBtn = h(
    "button",
    {
      className: "pl-link pl-storage-open",
      type: "button",
      onclick: () => import("./storage.js").then((mod) => mod.openStorage()),
    },
    "storage"
  );
  const storageHint = h(
    "div",
    { className: "pl-storage-hint", hidden: true },
    h("span", null, "storage can be optimized"),
    h(
      "button",
      {
        className: "pl-link",
        type: "button",
        onclick: () => import("./storage.js").then((mod) => mod.optimizeStorage()),
      },
      "Optimize"
    )
  );

  const foot = h(
    "div",
    { className: "pl-foot" },
    h("span", { className: "pl-pill" }, "comfyui-prompt-library"),
    h("span", null, `// output: text ${ARROW}`),
    h("span", { className: "pl-spacer" }),
    storageHint,
    storageBtn
  );

  // Remove aria-modal while hidden: ComfyUI treats any matching dialog as open
  // without checking visibility, which would block workflow shortcuts.
  const card = h("div", { className: "pl-card", role: "dialog", "aria-label": "Prompt Library" }, head, body, foot);

  // Keep layers outside .pl-card: contain: layout paint changes the containing
  // block for fixed descendants and would offset viewport-based popovers.
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

  Object.assign(els, { backdrop, card, head, sub, link, target, close: closeBtn, seg, body, rail, inspect, foot, storageBtn, storageHint, layers, toasts });
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
            // Seed the new binding from the node, which owns the rendered text.
            syncBinding();
            popLayer(handle);
          },
        },
        nodeLabel(node)
      )
    );
  }
  const rect = it.els.target.getBoundingClientRect();
  list.style.top = `${Math.round(rect.bottom + 6)}px`;
  list.style.left = `${Math.round(rect.left)}px`;
  const handle = pushLayer({ el: list, closeOnOutside: true });
}


export function wireShell() {
  const it = inst();
  const root = it.root;

  const paintStorage = (state) => {
    const storage = state.storage || {};
    const available = !state.caps || state.caps.storage !== false;
    if (it.els.storageBtn) it.els.storageBtn.hidden = !available;
    if (it.els.storageHint) it.els.storageHint.hidden = !available || !storage.should_compact;
    if (it.els.storageBtn) {
      it.els.storageBtn.textContent = "storage";
      it.els.storageBtn.title = "Storage, migration, import and export";
    }
  };
  // The retained shell is wired once, so this subscription intentionally
  // lives for the retained modal's lifetime.
  let storageSubs = it.subs.get("storage");
  if (!storageSubs) {
    storageSubs = new Set();
    it.subs.set("storage", storageSubs);
  }
  storageSubs.add(paintStorage);
  paintStorage(it.state);

  // ---- Escape + Ctrl/Cmd+S + Tab, through the key bus (see modal/keys.js) --
  onKey(root, "keydown", (e) => {
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      if (it.layers.length) popLayer();
      else attemptClose();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "s") {
      if (e.repeat) return; // a held chord must not queue saves
      // Let the top layer own save; do not save beneath an unresolved dialog.
      if (it.layers.length) return;
      const save = it.ctx && it.ctx.requestSave;
      if (typeof save !== "function") return; // inspector not mounted
      // Show the narrow-mode editor so save feedback and empty-body focus are visible.
      if (root.dataset.w === "narrow") setPane("edit");
      Promise.resolve()
        // true creates a new record; explicit Update owns overwrites.
        .then(() => save(true))
        .catch((err) => console.error(`${NS} Ctrl+S save failed`, err));
      return;
    }

    if (e.key === "Tab") handleTab(e);
  });

  // Require both press and release on the backdrop; drag-selection must not close.
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

/* Install per open: close disconnects the observer, so one-time wiring would
 * stop responding after the first close.
 */

export function installResponsive() {
  const it = inst();
  const root = it.root;

  const applyWidth = (w) => {
    const mode = w < NARROW_AT ? "narrow" : "wide";
    if (root.dataset.w === mode) return;
    root.dataset.w = mode;
    if (it.els.card) it.els.card.dataset.w = mode;
    if (mode === "wide") it.els.body.dataset.pane = "browse";
  };
  // Measure the root: narrow mode changes card padding/width and would otherwise
  // cause oscillation around the responsive threshold.
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
