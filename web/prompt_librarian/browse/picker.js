/* Keep an anchored local fallback so the rail works if pickers/ fails to load.
 */

import { NO_AUTOFILL, h } from "../shared/dom.js";

const GAP = 6;
const EDGE = 8;

/** Sentinel: openPopover could not mount, so we must fall back. */
const NO_POPOVER = Symbol("no-popover");

/**
 * @param {object} ctx modal ctx
 * @param {string} title
 * @param {string[]} options
 * @param {{allowNew?: boolean, anchor?: HTMLElement}} [opts] `anchor` is the
 *   element the popover is placed against — the button that was clicked.
 * @returns {Promise<string|null>}
 */
export async function pickOne(ctx, title, options, opts = {}) {
  const anchor = opts.anchor || null;
  try {
    const mod = await import("../pickers/index.js");
    if (typeof mod.openPicker === "function") {
      return await mod.openPicker({ title, options, ...opts, ctx });
    }
    if (anchor && typeof mod.openPopover === "function") {
      const picked = await viaPopover(mod.openPopover, ctx, title, options, opts, anchor);
      if (picked !== NO_POPOVER) return picked;
    }
  } catch (_) {
    /* unavailable — fall through to the built-in */
  }
  return builtIn(ctx, title, options, opts, anchor);
}

function fill(pop, ctx, title, options, opts, finish) {
  if (opts.allowNew) {
    const field = h("input", {
      className: "pl-input",
      type: "text",
      spellcheck: "false",
      ...NO_AUTOFILL,
      placeholder: "new " + title.toLowerCase(),
      "aria-label": title,
    });
    ctx.onKey(field, "keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const v = String(field.value || "").trim();
        if (v) finish(v);
      }
    });
    pop.appendChild(field);
  }
  if (!options.length) pop.appendChild(h("div", { className: "pl-opt" }, "(none yet)"));
  for (const opt of options) {
    pop.appendChild(
      h("button", { className: "pl-opt", type: "button", role: "option", onclick: () => finish(opt) }, opt)
    );
  }
}

function viaPopover(openPopover, ctx, title, options, opts, anchor) {
  return new Promise((resolve) => {
    let handle = null;
    let value = null;
    let settled = false;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    // Resolving on close (rather than on the click) keeps ONE resolve path for
    // picking, Escape and outside-click alike.
    const finish = (val) => {
      value = val;
      if (handle) handle.close();
      else settle(val);
    };
    handle = openPopover({
      anchor,
      ctx,
      placement: "bottom-start",
      className: "pl-pick-one",
      ariaLabel: title,
      render: (pop, own) => {
        handle = handle || own; // render runs inside openPopover, before it returns
        pop.setAttribute("role", "listbox");
        fill(pop, ctx, title, options, opts, finish);
      },
      onClose: () => settle(value),
    });
    if (!handle) resolve(NO_POPOVER);
  });
}

function builtIn(ctx, title, options, opts, anchor) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      ctx.popLayer(handle);
      resolve(val);
    };
    const pop = h("div", { className: "pl-popover", role: "listbox", "aria-label": title });
    fill(pop, ctx, title, options, opts, finish);
    pop.style.top = "0px";
    pop.style.left = "-9999px"; // measured off-screen, then placed
    const handle = ctx.pushLayer({ el: pop, closeOnOutside: true, onClose: () => finish(null) });
    if (!handle) {
      resolve(null);
      return;
    }
    place(pop, anchor); // after pushLayer: it must be in the DOM to be measured
  });
}

/** Local fallback when pickers/ is unavailable; preserve viewport placement rules.
 */
function place(el, anchor) {
  const rect =
    anchor && typeof anchor.getBoundingClientRect === "function"
      ? anchor.getBoundingClientRect()
      : null;
  if (!rect) {
    el.style.top = "20%";
    el.style.left = "0%";
    return;
  }
  const vw = (typeof window !== "undefined" && window.innerWidth) || 1280;
  const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
  const box = el.getBoundingClientRect();
  const w = box.width || el.offsetWidth || 220;
  const ht = box.height || el.offsetHeight || 160;

  const roomBelow = vh - EDGE - (rect.bottom + GAP);
  const roomAbove = rect.top - GAP - EDGE;
  const flip = ht > roomBelow && roomAbove > roomBelow;

  let top = flip ? rect.top - GAP - ht : rect.bottom + GAP;
  top = Math.max(EDGE, Math.min(top, Math.max(EDGE, vh - EDGE - ht)));
  const left = Math.max(EDGE, Math.min(rect.left, Math.max(EDGE, vw - EDGE - w)));

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}
