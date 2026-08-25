/* ==========================================================================
   Prompt Librarian — the inspector's own layers
   --------------------------------------------------------------------------
   INERT ON IMPORT. Exports only.

   Popovers and the two inline dialogs this pane owns (conflict + resolve).
   They go through `ctx.pushLayer` when the modal shell is there and fall back
   to appending into the document, so the SAVE GATE still works on an install
   where the shell or pickers/ failed to load.
   ========================================================================== */

/**
 * @param {object} pane the shared inspector state (see inspector/index.js)
 * @returns {{openLayer: Function, closeAllLayers: Function,
 *            openLocalPopover: Function, placePopover: Function}}
 */
export function createLayerHost(pane) {
  const { ctx, el, D } = pane;
  const h = D.h;
  const openLayers = new Set();

  function openLayer(node, opts = {}) {
    const rec = { node, closed: false, close: null };
    let handle = null;
    const finish = () => {
      if (rec.closed) return;
      rec.closed = true;
      openLayers.delete(rec);
      if (typeof opts.onClose === "function") { try { opts.onClose(); } catch (_) {} }
    };
    rec.close = () => {
      if (rec.closed) return;
      if (handle != null && typeof ctx.popLayer === "function") {
        rec.closed = true;
        openLayers.delete(rec);
        try { ctx.popLayer(handle); } catch (_) {}
        if (typeof opts.onClose === "function") { try { opts.onClose(); } catch (_) {} }
        return;
      }
      // Fallback path (no layer stack): we appended it ourselves.
      if (node && node.parentNode) node.parentNode.removeChild(node);
      finish();
    };
    if (typeof ctx.pushLayer === "function") {
      try {
        handle = ctx.pushLayer({
          el: node,
          onClose: finish,
          closeOnOutside: opts.closeOnOutside !== false,
        });
      } catch (_) { handle = null; }
    }
    if (handle == null) {
      const doc = (el && el.ownerDocument) || (typeof document !== "undefined" ? document : null);
      if (doc && doc.body && node) doc.body.appendChild(node);
    }
    openLayers.add(rec);
    return rec;
  }

  function closeAllLayers() {
    for (const rec of Array.from(openLayers)) {
      try { rec.close(); } catch (_) {}
    }
    openLayers.clear();
  }

  /** Position a `.pl-popover` against an anchor, flipping when it overflows. */
  function placePopover(pop, anchor, placement) {
    try {
      if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
      const r = anchor.getBoundingClientRect();
      const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
      const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
      pop.style.left = Math.max(8, Math.min(r.left, vw - 260)) + "px";
      if (placement === "overlay-start") {
        pop.style.top = Math.max(8, r.top) + "px";
        pop.style.bottom = "auto";
        pop.dataset.flip = "over";
        return;
      }
      const below = vh - r.bottom;
      if (below < 180 && r.top > below) {
        pop.style.bottom = Math.max(8, vh - r.top + 6) + "px";
        pop.style.top = "auto";
      } else {
        pop.style.top = r.bottom + 6 + "px";
        pop.style.bottom = "auto";
      }
    } catch (_) { /* positioning is cosmetic */ }
  }

  /**
   * Minimal local popover — the fallback for every picker while pickers/ is
   * unavailable (and the permanent implementation for the threshold control,
   * which is ours). Options are plain values; `withInput` adds a free-text row
   * so a new tag can still be created.
   */
  function openLocalPopover(anchor, options, onPick, opts = {}) {
    const pop = h("div", { className: "pl-popover", role: "listbox" });
    let layer = null;
    const pick = (v) => {
      if (layer) layer.close();
      onPick(v);
    };
    if (opts.withInput) {
      const inp = h("input", {
        className: "pl-opt",
        type: "text",
        spellcheck: "false",
        ...D.NO_AUTOFILL,
        placeholder: opts.placeholder || "new…",
        onkeydown: (e) => {
          if (e.key === "Enter") {
            const v = String(inp.value || "").trim();
            if (v) pick(v);
          }
        },
      });
      pop.appendChild(inp);
      setTimeout(() => { try { inp.focus(); } catch (_) {} }, 0);
    }
    if (!options.length && !opts.withInput) {
      pop.appendChild(h("div", { className: "pl-opt", "aria-disabled": "true" }, opts.emptyLabel || "nothing to pick"));
    }
    for (const o of options) {
      const value = o && typeof o === "object" ? o.value : o;
      const label = o && typeof o === "object" ? o.label : String(o);
      pop.appendChild(
        h(
          "button",
          {
            className: "pl-opt",
            type: "button",
            role: "option",
            "aria-selected": opts.selected != null && opts.selected === value ? "true" : "false",
            onclick: () => pick(value),
          },
          label
        )
      );
    }
    layer = openLayer(pop, { closeOnOutside: true });
    placePopover(pop, anchor, opts.placement);
    return layer;
  }

  return { openLayer, closeAllLayers, openLocalPopover, placePopover };
}
